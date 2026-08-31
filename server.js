// AURA standalone backend
// -------------------------------------------------------------------
// This runs AURA outside Claude, on Google's Gemini API — chosen
// because Gemini has a genuine, permanent free tier (no credit card,
// no expiring trial), unlike Anthropic's API. This file does three
// things:
//   1. Serves webapp/index.html as a normal webpage.
//   2. Proxies POST /api/messages to Google's Gemini API, attaching
//      YOUR Gemini API key server-side (never exposed to the browser).
//      The front-end (webapp/index.html) still builds its requests in
//      Anthropic's Messages API shape (model, system, messages, etc.)
//      unchanged — this file translates that shape to and from
//      Gemini's request/response format, so nothing else in the app
//      needed to be rewritten.
//   3. Gates that proxy behind an optional shared access code and a
//      per-visitor rate limit, so opening this to the public doesn't
//      mean strangers can burn through your daily Gemini quota alone.
//
// Setup:
//   1. npm install
//   2. Copy .env.example to .env and paste in a real Gemini API key —
//      get one free, no card required, at https://aistudio.google.com/apikey
//   3. Optionally set ACCESS_CODE, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MIN
//      in .env (see .env.example for what each does)
//   4. npm start
//   5. Open http://localhost:3000
//
// Requires Node.js 18+ (for the built-in global fetch).
//
// Deploying for real users (not just local testing) means hosting this
// on a real server (Render, Railway, Vercel, Fly.io, etc.) with your
// .env variables set there instead of on your own machine.
// -------------------------------------------------------------------

require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// --- Access code -----------------------------------------------------
// If ACCESS_CODE is set, every /api/messages request must include a
// matching "x-access-code" header. The public page asks the visitor for
// this code once and remembers it in their browser (see webapp/index.html).
// This is NOT strong security — it's a shared password, visible to anyone
// you give it to, and anyone determined enough could still poke at the
// endpoint directly. It exists to stop *casual* drive-by usage by people
// who just found the link, not to stop a determined attacker.
const ACCESS_CODE = process.env.ACCESS_CODE || '';

// --- Rate limiting -----------------------------------------------------
// Simple in-memory per-IP sliding-window limiter. Resets whenever the
// server restarts and doesn't share state across multiple server
// instances — fine for a single small deployment, not for a
// multi-instance production setup (you'd want Redis or similar there).
// This matters more now than it did with per-user keys: Gemini's free
// tier has a shared daily request cap on YOUR key, so this protects
// against one visitor (or a bot) using up the whole day's quota.
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '30', 10);
const RATE_LIMIT_WINDOW_MIN = parseInt(process.env.RATE_LIMIT_WINDOW_MIN || '60', 10);
const RATE_LIMIT_WINDOW_MS = RATE_LIMIT_WINDOW_MIN * 60 * 1000;
const rateLimitBuckets = new Map(); // ip -> array of request timestamps (ms)

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (rateLimitBuckets.get(ip) || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  if (timestamps.length >= RATE_LIMIT_MAX) {
    rateLimitBuckets.set(ip, timestamps);
    return true;
  }
  timestamps.push(now);
  rateLimitBuckets.set(ip, timestamps);
  return false;
}

// Periodically clear out old entries so this map doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of rateLimitBuckets.entries()) {
    const fresh = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (fresh.length === 0) rateLimitBuckets.delete(ip);
    else rateLimitBuckets.set(ip, fresh);
  }
}, 10 * 60 * 1000).unref();

if (!GEMINI_API_KEY) {
  console.warn('\n⚠️  GEMINI_API_KEY is not set. Copy .env.example to .env and add a free key from https://aistudio.google.com/apikey, or AURA\'s AI replies will fail.\n');
}
if (!ACCESS_CODE) {
  console.warn('\n⚠️  ACCESS_CODE is not set. The public chat endpoint is open to anyone who finds this URL, with only the rate limit protecting your daily quota. Set ACCESS_CODE in .env to require a shared password.\n');
}

app.set('trust proxy', true); // needed to get the real visitor IP behind Render/Railway/Vercel/Fly's proxy
app.use(express.json({ limit: '15mb' })); // generous limit for image attachments
app.use(express.static(path.join(__dirname, 'webapp'), {
  // index.html is the app shell — it must never be cached by the browser
  // or any CDN in front of this, or updates won't reach returning visitors.
  // Other static files (icons, manifest) can still cache normally.
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
    }
  }
}));

// Diagnostic-only endpoint: plain text, no caching, no service worker
// involvement at all. Used to unambiguously confirm which deployment is
// actually being served when troubleshooting stale-content issues.
app.get('/api/whoami', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('text/plain').send('AURA gemini-backend build — ' + new Date().toISOString());
});

// Diagnostic-only endpoint: lists exactly what files this running server
// actually sees on disk, to debug "webapp folder not found" style issues
// without needing shell/SSH access to the host.
app.get('/api/debug-files', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const fs = require('fs');
  try {
    const rootFiles = fs.readdirSync(__dirname);
    let webappFiles = null;
    let webappError = null;
    try {
      webappFiles = fs.readdirSync(path.join(__dirname, 'webapp'));
    } catch (e) {
      webappError = String(e);
    }
    res.json({ __dirname, rootFiles, webappFiles, webappError });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Lets the public page know whether it needs to show an access-code
// prompt at all — never reveals the actual code.
app.get('/api/config', (req, res) => {
  res.json({ accessCodeRequired: !!ACCESS_CODE });
});

// --- Anthropic-shape <-> Gemini-shape translation -----------------------
// The front-end (webapp/index.html) was originally built to talk to
// Anthropic's Messages API, and still sends requests in that shape:
//   { model, max_tokens, system, messages: [{role:'user'|'assistant', content}], tools? }
// where `content` is either a plain string or an array of blocks like
//   {type:'text', text} or {type:'image', source:{type:'base64', media_type, data}}
// Gemini's generateContent API expects a different shape:
//   { systemInstruction, contents: [{role:'user'|'model', parts:[...]}], generationConfig, tools? }
// where each part is {text} or {inlineData:{mimeType, data}}.
// These two functions convert one way and back, so nothing on the
// front-end needed to change.

function anthropicContentToGeminiParts(content) {
  if (typeof content === 'string') {
    return [{ text: content }];
  }
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (block.type === 'image' && block.source && block.source.type === 'base64') {
        return { inlineData: { mimeType: block.source.media_type, data: block.source.data } };
      }
      // text blocks, and anything else unrecognized, fall back to text
      return { text: block.text || '' };
    });
  }
  return [{ text: String(content || '') }];
}

function anthropicRequestToGemini(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: anthropicContentToGeminiParts(m.content)
  }));

  const geminiBody = {
    contents,
    generationConfig: {
      maxOutputTokens: body.max_tokens || 1024
    }
  };

  if (body.system) {
    geminiBody.systemInstruction = { parts: [{ text: body.system }] };
  }

  // The front-end asks for Anthropic's built-in web_search tool on
  // premium requests. Gemini's equivalent is its own built-in Google
  // Search grounding tool — map one onto the other so live web search
  // still works instead of silently dropping the capability.
  if (Array.isArray(body.tools) && body.tools.some((t) => t.type === 'web_search_20250305')) {
    geminiBody.tools = [{ google_search: {} }];
  }

  return geminiBody;
}

function geminiResponseToAnthropic(geminiJson) {
  const candidate = geminiJson && geminiJson.candidates && geminiJson.candidates[0];
  const parts = (candidate && candidate.content && candidate.content.parts) || [];
  const content = parts
    .filter((p) => typeof p.text === 'string')
    .map((p) => ({ type: 'text', text: p.text }));
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }
  return { content };
}

app.post('/api/messages', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({
      error: 'missing_api_key',
      message: 'Server is missing GEMINI_API_KEY. Add a free key from https://aistudio.google.com/apikey as an environment variable. See .env.example.'
    });
  }

  if (ACCESS_CODE) {
    const provided = req.get('x-access-code') || '';
    if (provided !== ACCESS_CODE) {
      return res.status(401).json({
        error: 'invalid_access_code',
        message: 'This app requires an access code. Enter the code you were given.'
      });
    }
  }

  const visitorIp = req.ip || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(visitorIp)) {
    return res.status(429).json({
      error: 'rate_limited',
      message: `You've hit the message limit for this app (${RATE_LIMIT_MAX} messages per ${RATE_LIMIT_WINDOW_MIN} minutes). Try again later.`
    });
  }

  const controller = new AbortController();
  const REQUEST_TIMEOUT_MS = 30000;
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const geminiBody = anthropicRequestToGemini(req.body || {});
    const model = GEMINI_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const rawText = await upstream.text();

    if (upstream.status === 429) {
      return res.status(429).json({
        error: 'rate_limited',
        message: 'Google\'s free Gemini tier is rate-limiting requests right now (its own daily/per-minute cap, separate from this app\'s own limit). Wait a moment and try again.',
        retryAfter: upstream.headers.get('retry-after') || null
      });
    }

    if (!upstream.ok) {
      let message = rawText;
      try {
        const parsed = JSON.parse(rawText);
        message = (parsed && parsed.error && parsed.error.message) || rawText;
      } catch (_) { /* not JSON — use raw text as-is */ }
      return res.status(upstream.status).json({
        error: 'upstream_error',
        message: message || `Gemini API returned status ${upstream.status}`
      });
    }

    let geminiJson;
    try {
      geminiJson = JSON.parse(rawText);
    } catch (parseErr) {
      return res.status(502).json({
        error: 'malformed_reply',
        message: 'Received a response from the AI provider that could not be read as valid JSON.'
      });
    }

    const anthropicShaped = geminiResponseToAnthropic(geminiJson);
    res.status(200).json(anthropicShaped);

  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      return res.status(504).json({
        error: 'timeout',
        message: `The request to the AI provider timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`
      });
    }
    console.error('Proxy error:', err);
    res.status(502).json({
      error: 'network_error',
      message: 'Failed to reach the Gemini API.',
      detail: String(err)
    });
  }
});

// Only start listening when this file is run directly (e.g. `npm start`
// on Render/locally). When Vercel imports this file as a serverless
// function (see api/index.js), it calls the exported app directly on
// each request instead, so app.listen() here would be pointless (and
// serverless platforms don't keep a process running to listen anyway).
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`AURA standalone server running at http://localhost:${PORT}`);
  });
}

module.exports = app;

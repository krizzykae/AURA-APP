// AURA standalone backend
// -------------------------------------------------------------------
// This is the piece that makes AURA work outside Claude. It does three
// things:
//   1. Serves public/index.html as a static page.
//   2. Proxies POST /api/messages to Anthropic's real API, attaching
//      YOUR real API key server-side — the key never reaches the
//      browser, so it can't be stolen by anyone opening the page.
//   3. Gates that proxy behind a shared access code and a per-visitor
//      rate limit, so opening this to the public doesn't mean strangers
//      can run up unlimited charges on your API key.
//
// Setup:
//   1. npm install
//   2. Copy .env.example to .env and paste in your real Anthropic API
//      key (get one at https://console.anthropic.com/settings/keys)
//   3. Optionally set ACCESS_CODE, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MIN
//      in .env (see .env.example for what each does)
//   4. npm start
//   5. Open http://localhost:3000
//
// Requires Node.js 18+ (for the built-in global fetch).
//
// Deploying for real users (not just local testing) means hosting this
// on a real server (Render, Railway, Fly.io, a VPS, etc.) with your
// .env variables set there instead of on your own machine.
// -------------------------------------------------------------------

require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;

// --- Access code -----------------------------------------------------
// If ACCESS_CODE is set, every /api/messages request must include a
// matching "x-access-code" header. The public page asks the visitor for
// this code once and remembers it in their browser (see public/index.html).
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

if (!API_KEY) {
  console.warn('\n⚠️  ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your real key, or AURA\'s AI replies will fail.\n');
}
if (!ACCESS_CODE) {
  console.warn('\n⚠️  ACCESS_CODE is not set. The public chat endpoint is open to anyone who finds this URL, with only the rate limit protecting your API bill. Set ACCESS_CODE in .env to require a shared password.\n');
}

app.set('trust proxy', true); // needed to get the real visitor IP behind Render/Railway/Fly's proxy
app.use(express.json({ limit: '15mb' })); // generous limit for image attachments
app.use(express.static(path.join(__dirname, 'public')));

// Lets the public page know whether it needs to show an access-code
// prompt at all — never reveals the actual code.
app.get('/api/config', (req, res) => {
  res.json({ accessCodeRequired: !!ACCESS_CODE });
});

app.post('/api/messages', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({
      error: 'missing_api_key',
      message: 'Server is missing ANTHROPIC_API_KEY. On Replit, add it under Secrets; locally, put it in .env. See .env.example.'
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
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const rawText = await upstream.text();

    // Rate limiting — surface this distinctly so the UI can say "try again
    // shortly" instead of a generic failure.
    if (upstream.status === 429) {
      return res.status(429).json({
        error: 'rate_limited',
        message: 'The AI provider is rate-limiting requests right now. Wait a moment and try again.',
        retryAfter: upstream.headers.get('retry-after') || null
      });
    }

    // Any other non-2xx from Anthropic (bad key, bad request, server error,
    // etc.) — try to pull their real error message out, fall back to raw text.
    if (!upstream.ok) {
      let message = rawText;
      try {
        const parsed = JSON.parse(rawText);
        message = (parsed && parsed.error && parsed.error.message) || rawText;
      } catch (_) { /* not JSON — use raw text as-is */ }
      return res.status(upstream.status).json({
        error: 'upstream_error',
        message: message || `Anthropic API returned status ${upstream.status}`
      });
    }

    // Success status, but confirm the body is actually valid JSON before
    // relaying it — an unreadable "success" is worse than a clear error.
    try {
      JSON.parse(rawText);
    } catch (parseErr) {
      return res.status(502).json({
        error: 'malformed_reply',
        message: 'Received a response from the AI provider that could not be read as valid JSON.'
      });
    }

    res.status(200);
    res.set('Content-Type', 'application/json');
    res.send(rawText);

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
      message: 'Failed to reach the Anthropic API.',
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

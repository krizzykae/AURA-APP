# AURA — standalone version

This runs AURA outside Claude, using your own real Anthropic API key.
It's a small Node.js server that does exactly two things:

1. Serves the AURA app (`public/index.html`) as a normal webpage.
2. Proxies chat requests to Anthropic's real API, attaching your key
   **on the server** so it's never exposed in the browser.

## Run it locally

```bash
npm install
cp .env.example .env
# open .env and paste in a real key from https://console.anthropic.com/settings/keys
npm start
```

Then open **http://localhost:3000** in your browser.

## What works here vs. inside Claude

| Feature | Inside Claude | Standalone (this) |
|---|---|---|
| AI chat replies | Yes | Yes (uses your real key — you pay per message) |
| Live web search | Yes | Yes |
| Website builder + preview | Yes | Yes |
| Data persistence (tasks, memory, trial) | Tied to your Claude account, follows you across devices | Stored in the browser's localStorage — per device, cleared if the user clears browser data |
| Apple Music previews | Yes | Yes (no key needed, public embeds) |
| 60-day trial / promo code / paywall | Yes | Same logic, same honesty caveat below |

## Costs

Every message sent through this now goes to Anthropic's API on **your**
account and **you are billed for it** — this is real usage, not a demo.
Check current pricing at https://www.anthropic.com/pricing before
opening this up to other people.

## The paywall, deployed for real

The subscription/promo-code logic in Settings is still **client-side
only** — it lives in the page's own JavaScript. This means:

- It will correctly show the 60-day trial countdown and lock premium
  features afterward for ordinary users.
- It is **not** tamper-proof: anyone who opens their browser's dev
  tools can bypass it, since there's no server checking whether they
  actually paid.
- To make it real security (not just a real feature), you'd need to
  move the premium/trial check into server.js itself, tied to a real
  user login and a real Stripe webhook confirming payment. That's a
  meaningfully bigger project — say the word if you want to go there
  next.

## Deploying so other people can use it (not just your own machine)

Running `npm start` only serves it on your computer. To put this on
the real internet:

1. Push this folder to a host that runs Node.js servers — Render,
   Railway, and Fly.io all have simple free/cheap tiers for exactly this.
2. Set `ANTHROPIC_API_KEY` as an environment variable in that host's
   dashboard (not in a committed `.env` file).
3. Point your domain (if you have one) at it.

## Files in this folder

- `server.js` — the proxy server. Read the comment at the top.
- `public/index.html` — the AURA app itself (same file discussed
  throughout our conversation, with one line changed: it calls
  `/api/messages` on this server instead of Anthropic directly).
- `package.json` / `.env.example` — standard Node.js project files.

## Installing on iPhone or Android (PWA)

This app is now a real installable Progressive Web App — no App Store or
Play Store submission needed, and no separate "mobile file" to download.
Once this server is hosted somewhere real (see the deploying section
above — `npm start` alone only works on your own machine, not on someone
else's phone):

**iPhone (Safari):**
1. Open the hosted URL in **Safari** (must be Safari, not Chrome — iOS
   only allows installing from Safari).
2. Tap the **Share** icon (square with an arrow).
3. Tap **Add to Home Screen**.

**Android (Chrome):**
1. Open the hosted URL in **Chrome**.
2. Chrome will usually show an **"Install app"** banner automatically,
   or tap the **⋮** menu → **Install app** / **Add to Home screen**.

Either way, it then behaves like a real installed app: its own icon, full
screen, no browser address bar.

## What this is (and isn't)

This is a real, working PWA install — not a compiled `.ipa` or `.apk`.
Those require Xcode + an Apple Developer account (iOS) or the Android
SDK/Gradle build tools + a signing key (Android), none of which can be
produced from a chat conversation. A PWA gets you the same "icon on your
home screen, runs full-screen" experience without any of that — for a
real app-store listing later, tools like Capacitor can wrap this same
HTML into a real iOS/Android project, but that's a separate build step
requiring those real toolchains on your own machine.

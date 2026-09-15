// Sends the sample Sentry issue-alert payload to a deployed relay, signed the way
// Sentry signs webhooks, to exercise the relay and routine without Sentry.
// Usage: SENTRY_CLIENT_SECRET=... node relay/scripts/send-sample.js <relay-url>
import { execSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [relayUrl] = process.argv.slice(2);
const secret = process.env.SENTRY_CLIENT_SECRET;
if (!relayUrl || !secret) {
  console.error('Usage: SENTRY_CLIENT_SECRET=... node relay/scripts/send-sample.js <relay-url>');
  process.exit(1);
}

const payload = JSON.parse(readFileSync(new URL('../test/fixtures/event-alert.json', import.meta.url), 'utf8'));
payload.data.event.datetime = new Date().toISOString();
try {
  payload.data.event.release = execSync('git rev-parse origin/main', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {
  // Keep the fixture's release when there is no origin/main to point at.
}

const body = JSON.stringify(payload);
const res = await fetch(relayUrl, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'sentry-hook-resource': 'event_alert',
    'sentry-hook-timestamp': String(Math.floor(Date.now() / 1000)),
    'sentry-hook-signature': createHmac('sha256', secret).update(body).digest('hex'),
  },
  body,
});

console.log(`Relay responded HTTP ${res.status}`);
if (res.status === 202) console.log('The routine is being fired. Follow it with `wrangler tail` in relay/ or at https://claude.ai/code');

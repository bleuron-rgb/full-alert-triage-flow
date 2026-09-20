// Sends the sample Sentry issue-alert payload to the running service, signed the way
// Sentry signs webhooks, to exercise the webhook and the routine without Sentry.
// Usage: SENTRY_CLIENT_SECRET=... node scripts/send-sample.js https://orders-api.fly.dev
import { execSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const target = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const secret = process.env.SENTRY_CLIENT_SECRET;
if (!secret) {
  console.error('Usage: SENTRY_CLIENT_SECRET=... node scripts/send-sample.js [base-url]');
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
const res = await fetch(`${target}/internal/sentry-alert`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'sentry-hook-resource': 'event_alert',
    'sentry-hook-timestamp': String(Math.floor(Date.now() / 1000)),
    'sentry-hook-signature': createHmac('sha256', secret).update(body).digest('hex'),
  },
  body,
});

console.log(`${target} responded HTTP ${res.status}`);
if (res.status === 202) console.log('The routine is being fired; watch it at https://claude.ai/code');
if (res.status === 404) console.log('The endpoint is closed: SENTRY_CLIENT_SECRET is not set on that instance.');

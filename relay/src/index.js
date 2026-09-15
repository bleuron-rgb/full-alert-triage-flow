// Cloudflare Worker that receives Sentry issue-alert webhooks and fires the
// alert-triage routine. Sentry webhooks cannot send custom headers, and the
// routine's /fire endpoint requires a bearer token plus beta headers.
import { formatAlert, verifySentrySignature } from './alert.js';

const FIRE_HEADERS = {
  'anthropic-beta': 'experimental-cc-routine-2026-04-01',
  'anthropic-version': '2023-06-01',
  'content-type': 'application/json',
};

async function fireRoutine(env, text) {
  const res = await fetch(env.ROUTINE_FIRE_URL, {
    method: 'POST',
    headers: { ...FIRE_HEADERS, authorization: `Bearer ${env.ROUTINE_FIRE_TOKEN}` },
    body: JSON.stringify({ text }),
  });
  const body = await res.text();
  if (res.ok) console.log(`Routine fired: ${body}`);
  else console.error(`Routine fire failed with HTTP ${res.status}: ${body}`);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    const rawBody = await request.text();
    const signature = request.headers.get('sentry-hook-signature');
    if (!(await verifySentrySignature(rawBody, signature, env.SENTRY_CLIENT_SECRET))) {
      return new Response('Invalid signature', { status: 401 });
    }

    // Only issue-alert actions carry the event and its stack trace. Other resources,
    // such as the installation webhook sent when the integration is created, are ignored.
    if (request.headers.get('sentry-hook-resource') !== 'event_alert') {
      return new Response(null, { status: 204 });
    }

    const { data } = JSON.parse(rawBody);
    // Sentry treats responses slower than one second as timeouts, so fire after responding.
    ctx.waitUntil(fireRoutine(env, formatAlert(data)));
    return new Response(null, { status: 202 });
  },
};

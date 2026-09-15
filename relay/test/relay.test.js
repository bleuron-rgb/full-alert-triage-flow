import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { formatAlert, verifySentrySignature } from '../src/alert.js';
import worker from '../src/index.js';

const payload = JSON.parse(readFileSync(new URL('./fixtures/event-alert.json', import.meta.url), 'utf8'));
const secret = 'test-client-secret';
const sign = (body) => createHmac('sha256', secret).update(body).digest('hex');

test('formatAlert includes the rule, error, release, and Sentry link', () => {
  const text = formatAlert(payload.data);
  assert.match(text, /^Sentry issue alert fired: orders-api error spike$/m);
  assert.match(text, /^TypeError: Cannot read properties of undefined \(reading 'tier'\)$/m);
  assert.match(text, /^Release \(deployed git commit\): [0-9a-f]{40}$/m);
  assert.match(text, /^Sentry event link: https:\/\/\S+$/m);
});

test('formatAlert lists the newest frame first with source lines for in-app frames only', () => {
  const lines = formatAlert(payload.data).split('\n');
  const frames = lines.filter((line) => line.startsWith('  at '));
  assert.match(frames[0], /^  at loyaltyDiscount \(app:\/\/\/src\/pricing\.js:13:45\)$/);
  assert.ok(frames.some((line) => line.endsWith('[library]')), 'expected at least one library frame');
  assert.equal(lines[lines.indexOf(frames[0]) + 1], '      > return LOYALTY_DISCOUNTS[customer.loyalty.tier] ?? 0;');
  for (const frame of frames.filter((line) => line.endsWith('[library]'))) {
    assert.doesNotMatch(lines[lines.indexOf(frame) + 1] ?? '', /^ {6}>/);
  }
});

test('formatAlert truncates to the /fire text limit', () => {
  const data = structuredClone(payload.data);
  data.event.title = 'x'.repeat(70_000);
  const text = formatAlert(data);
  assert.equal(text.length, 65_536);
  assert.match(text, /\[truncated\]$/);
});

test('verifySentrySignature accepts a signature over the raw or re-serialized body', async () => {
  const pretty = JSON.stringify(payload, null, 2);
  assert.equal(await verifySentrySignature(pretty, sign(pretty), secret), true);
  assert.equal(await verifySentrySignature(pretty, sign(JSON.stringify(payload)), secret), true);
});

test('verifySentrySignature rejects bad signatures and a missing secret', async () => {
  const body = JSON.stringify(payload);
  assert.equal(await verifySentrySignature(body, sign(`${body} `), secret), false);
  assert.equal(await verifySentrySignature(body, 'not-hex', secret), false);
  assert.equal(await verifySentrySignature(body, null, secret), false);
  assert.equal(await verifySentrySignature(body, sign(body), undefined), false);
});

test('worker fires the routine only for signed event_alert webhooks', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('{"type":"routine_fire"}'));
  t.mock.method(console, 'log', () => {});
  const env = { SENTRY_CLIENT_SECRET: secret, ROUTINE_FIRE_URL: 'https://example.test/fire', ROUTINE_FIRE_TOKEN: 'tok' };
  const pending = [];
  const ctx = { waitUntil: (promise) => pending.push(promise) };
  const body = JSON.stringify(payload);
  const webhook = (resource, signature = sign(body)) => new Request('https://relay.test/', {
    method: 'POST',
    body,
    headers: { 'sentry-hook-resource': resource, 'sentry-hook-signature': signature },
  });

  assert.equal((await worker.fetch(new Request('https://relay.test/'), env, ctx)).status, 405);
  assert.equal((await worker.fetch(webhook('event_alert', sign('tampered')), env, ctx)).status, 401);
  assert.equal((await worker.fetch(webhook('installation'), env, ctx)).status, 204);
  assert.equal((await worker.fetch(webhook('event_alert'), env, ctx)).status, 202);
  await Promise.all(pending);

  assert.equal(fetchMock.mock.callCount(), 1);
  const [url, init] = fetchMock.mock.calls[0].arguments;
  assert.equal(url, env.ROUTINE_FIRE_URL);
  assert.equal(init.headers.authorization, 'Bearer tok');
  assert.equal(init.headers['anthropic-beta'], 'experimental-cc-routine-2026-04-01');
  assert.equal(init.headers['anthropic-version'], '2023-06-01');
  assert.equal(JSON.parse(init.body).text, formatAlert(payload.data));
});

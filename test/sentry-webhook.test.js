import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import {
  SENTRY_WEBHOOK_PATH,
  formatAlert,
  handleSentryWebhook,
  verifySentrySignature,
} from '../src/sentry-webhook.js';

const payload = JSON.parse(readFileSync(new URL('./fixtures/event-alert.json', import.meta.url), 'utf8'));
const secret = 'test-client-secret';
const config = { clientSecret: secret, fireUrl: 'https://example.test/fire', fireToken: 'tok' };
const sign = (body) => createHmac('sha256', secret).update(body).digest('hex');

function request({ url = SENTRY_WEBHOOK_PATH, method = 'POST', body = '', headers = {} } = {}) {
  const req = Readable.from([body]);
  return Object.assign(req, { url, method, headers });
}

function response() {
  return {
    status: null,
    body: '',
    headersSent: false,
    writeHead(status) {
      this.status = status;
      this.headersSent = true;
    },
    end(chunk = '') {
      this.body += chunk;
    },
  };
}

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

test('the handler ignores requests for other routes', async () => {
  const res = response();
  assert.equal(await handleSentryWebhook(request({ url: '/orders/o_1001/total' }), res, config), false);
  assert.equal(res.status, null);
});

test('the endpoint does not exist without a client secret', async () => {
  const res = response();
  const handled = await handleSentryWebhook(request(), res, { ...config, clientSecret: undefined });
  assert.equal(handled, true);
  assert.equal(res.status, 404);
});

test('the handler rejects the wrong method and a bad signature', async () => {
  const wrongMethod = response();
  await handleSentryWebhook(request({ method: 'GET' }), wrongMethod, config);
  assert.equal(wrongMethod.status, 405);

  const body = JSON.stringify(payload);
  const badSignature = response();
  await handleSentryWebhook(
    request({ body, headers: { 'sentry-hook-signature': sign('tampered'), 'sentry-hook-resource': 'event_alert' } }),
    badSignature,
    config,
  );
  assert.equal(badSignature.status, 401);
});

test('the handler acknowledges resources other than event_alert without firing', async () => {
  const body = JSON.stringify(payload);
  const res = response();
  const fired = [];
  await handleSentryWebhook(
    request({ body, headers: { 'sentry-hook-signature': sign(body), 'sentry-hook-resource': 'installation' } }),
    res,
    config,
    async (...args) => fired.push(args),
  );
  assert.equal(res.status, 204);
  assert.equal(fired.length, 0);
});

test('a signed issue alert answers 202 and fires the routine with the formatted text', async () => {
  const body = JSON.stringify(payload);
  const res = response();
  const fired = [];
  await handleSentryWebhook(
    request({ body, headers: { 'sentry-hook-signature': sign(body), 'sentry-hook-resource': 'event_alert' } }),
    res,
    config,
    async (passedConfig, text) => fired.push({ passedConfig, text }),
  );
  assert.equal(res.status, 202);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].passedConfig.fireToken, 'tok');
  assert.equal(fired[0].text, formatAlert(payload.data));
});

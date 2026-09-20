// Turns a Sentry issue-alert webhook into the plain-text alert body sent to the routine.

const MAX_TEXT_CHARS = 65_536;
const MAX_FRAMES = 30;
const MAX_LOCALS_CHARS = 600;

const encoder = new TextEncoder();

function truncate(text, maxChars) {
  const marker = '\n[truncated]';
  return text.length <= maxChars ? text : text.slice(0, maxChars - marker.length) + marker;
}

function hexToBytes(hex) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g), (pair) => parseInt(pair, 16));
}

// Sentry documents the signature as HMAC-SHA256(clientSecret, JSON.stringify(body)).
// The raw body is checked too, in case it was already serialized exactly that way.
export async function verifySentrySignature(rawBody, signatureHex, clientSecret) {
  const signature = signatureHex ? hexToBytes(signatureHex) : null;
  if (!signature || !clientSecret) return false;

  let reserialized;
  try {
    reserialized = JSON.stringify(JSON.parse(rawBody));
  } catch {
    return false;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(clientSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  for (const candidate of new Set([rawBody, reserialized])) {
    if (await crypto.subtle.verify('HMAC', key, signature, encoder.encode(candidate))) return true;
  }
  return false;
}

function formatFrame(frame) {
  const file = frame.filename ?? frame.abs_path ?? '?';
  const position = [frame.lineno, frame.colno].filter(Boolean).join(':');
  const lines = [`  at ${frame.function ?? '<anonymous>'} (${file}${position ? `:${position}` : ''})${frame.in_app ? '' : ' [library]'}`];
  if (frame.in_app && frame.context_line) lines.push(`      > ${frame.context_line.trim()}`);
  if (frame.in_app && frame.vars && Object.keys(frame.vars).length) {
    lines.push(`      locals: ${truncate(JSON.stringify(frame.vars), MAX_LOCALS_CHARS)}`);
  }
  return lines;
}

function formatException(exception) {
  const frames = exception.stacktrace?.frames ?? [];
  // Sentry lists frames oldest first; print newest first, like a Node.js stack trace.
  const shown = frames.slice(-MAX_FRAMES).reverse();
  const lines = [`${exception.type ?? 'Error'}: ${exception.value ?? ''}`, ...shown.flatMap(formatFrame)];
  if (frames.length > shown.length) lines.push(`  ... ${frames.length - shown.length} older frames omitted`);
  return lines.join('\n');
}

export function formatAlert(data) {
  const event = data?.event ?? {};
  const tags = Object.fromEntries(event.tags ?? []);
  const request = event.request?.url ? `${event.request.method ?? ''} ${event.request.url}`.trim() : null;

  const lines = [
    `Sentry issue alert fired: ${data?.triggered_rule ?? data?.issue_alert?.title ?? 'unknown rule'}`,
    `Issue: ${event.title ?? 'unknown'}`,
    `Culprit: ${event.culprit ?? 'unknown'}`,
    `Level: ${event.level ?? 'unknown'}`,
    `Environment: ${event.environment ?? tags.environment ?? 'unknown'}`,
    `Release (deployed git commit): ${event.release ?? tags.release ?? 'unknown'}`,
    `Event time: ${event.datetime ?? 'unknown'}`,
    ...(request ? [`Request: ${request}`] : []),
    `Sentry issue ID: ${event.issue_id ?? 'unknown'}`,
    `Sentry event link: ${event.web_url ?? 'unavailable'}`,
    '',
    'Stack trace (most recent call first):',
    ...(event.exception?.values ?? []).map(formatException),
  ];
  return truncate(lines.join('\n'), MAX_TEXT_CHARS);
}

// The endpoint Sentry posts issue alerts to. It verifies the signature, answers
// inside Sentry's one-second budget, and fires the routine afterwards.
//
// Errors raised in here are logged and never sent to Sentry: an event raised while
// handling an alert could fire the alert rule, which would post here again.
export const SENTRY_WEBHOOK_PATH = '/internal/sentry-alert';

const FIRE_HEADERS = {
  'anthropic-beta': 'experimental-cc-routine-2026-04-01',
  'anthropic-version': '2023-06-01',
  'content-type': 'application/json',
};

export function webhookConfigFromEnv(env = process.env) {
  return {
    clientSecret: env.SENTRY_CLIENT_SECRET,
    fireUrl: env.ROUTINE_FIRE_URL,
    fireToken: env.ROUTINE_FIRE_TOKEN,
  };
}

async function fireRoutine({ fireUrl, fireToken }, text) {
  const res = await fetch(fireUrl, {
    method: 'POST',
    headers: { ...FIRE_HEADERS, authorization: `Bearer ${fireToken}` },
    body: JSON.stringify({ text }),
  });
  const body = await res.text();
  if (res.ok) console.log(`Routine fired: ${body}`);
  else console.error(`Routine fire failed with HTTP ${res.status}: ${body}`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function send(res, status, body = '') {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

// Returns true when it took responsibility for the request.
export async function handleSentryWebhook(req, res, config = webhookConfigFromEnv(), fire = fireRoutine) {
  if ((req.url ?? '').split('?')[0] !== SENTRY_WEBHOOK_PATH) return false;

  // Without a secret the endpoint cannot tell a real alert from anything else, so
  // it does not exist. This is what keeps staging from firing the routine.
  if (!config.clientSecret) {
    send(res, 404, JSON.stringify({ error: 'not_found' }));
    return true;
  }

  if (req.method !== 'POST') {
    send(res, 405, JSON.stringify({ error: 'method_not_allowed' }));
    return true;
  }

  const rawBody = await readBody(req);
  const signature = req.headers['sentry-hook-signature'];
  if (!(await verifySentrySignature(rawBody, signature, config.clientSecret))) {
    send(res, 401, JSON.stringify({ error: 'invalid_signature' }));
    return true;
  }

  // Only issue-alert actions carry the event and its stack trace. Other resources,
  // such as the installation webhook, are acknowledged and ignored.
  if (req.headers['sentry-hook-resource'] !== 'event_alert') {
    send(res, 204);
    return true;
  }

  const { data } = JSON.parse(rawBody);
  // Answer first: Sentry treats a response slower than one second as a timeout.
  send(res, 202);
  fire(config, formatAlert(data)).catch((err) => console.error(`Routine fire failed: ${err.stack}`));
  return true;
}

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

import http from 'node:http';
import * as Sentry from '@sentry/node';
import { createHandler } from './app.js';
import { handleSentryWebhook } from './sentry-webhook.js';

const PORT = Number(process.env.PORT ?? 3000);

function reportError(err) {
  console.error(err.stack);
  Sentry.captureException(err);
}

const app = createHandler({ onError: reportError });

// The Sentry webhook is mounted here rather than in app.js so that the code
// deciding whether alerts reach the triage routine stays outside the files an
// automatic fix is allowed to touch.
http.createServer(async (req, res) => {
  try {
    if (await handleSentryWebhook(req, res)) return;
  } catch (err) {
    // Deliberately not reported to Sentry: see src/sentry-webhook.js.
    console.error(err.stack);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error' }));
    }
    return;
  }
  app(req, res);
}).listen(PORT, () => {
  console.log(`orders-api listening on http://localhost:${PORT}`);
});

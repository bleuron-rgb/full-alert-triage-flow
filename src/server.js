import http from 'node:http';
import * as Sentry from '@sentry/node';
import { createHandler } from './app.js';

const PORT = Number(process.env.PORT ?? 3000);

function reportError(err) {
  console.error(err.stack);
  Sentry.captureException(err);
}

http.createServer(createHandler({ onError: reportError })).listen(PORT, () => {
  console.log(`orders-api listening on http://localhost:${PORT}`);
});

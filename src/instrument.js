import { execSync } from 'node:child_process';
import * as Sentry from '@sentry/node';

function currentCommit() {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return undefined;
  }
}

// Without SENTRY_DSN the SDK stays disabled and errors are only logged locally.
// The release defaults to the checked-out commit so every event points at exact code.
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT ?? 'development',
  release: process.env.SENTRY_RELEASE ?? currentCommit(),
  includeLocalVariables: true,
});

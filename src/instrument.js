import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as Sentry from '@sentry/node';

const repoRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/');

// The built-in root option mishandles Windows drive-letter paths, so normalize
// slashes and strip the repo root directly. Dependencies stay out of app frames.
function toRepoRelativeFrame(frame) {
  const path = frame.filename?.replace(/\\/g, '/');
  if (!path?.startsWith(repoRoot)) return frame;
  const relativePath = path.slice(repoRoot.length);
  return {
    ...frame,
    filename: `app:///${relativePath}`,
    in_app: frame.in_app && !relativePath.startsWith('node_modules/'),
  };
}

function currentCommit() {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return undefined;
  }
}

// Without SENTRY_DSN the SDK stays disabled and errors are only logged locally.
// The release defaults to the checked-out commit so every event points at exact code,
// and frame paths are rewritten relative to the repo root (app:///src/...) so they
// match repository paths instead of exposing the local checkout location.
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT ?? 'development',
  release: process.env.SENTRY_RELEASE ?? currentCommit(),
  includeLocalVariables: true,
  integrations: [Sentry.rewriteFramesIntegration({ iteratee: toRepoRelativeFrame })],
});

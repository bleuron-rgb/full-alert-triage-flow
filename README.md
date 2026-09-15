# full-alert-triage-flow

An end-to-end demo of alert triage with a [Claude Code routine](https://code.claude.com/docs/en/routines):

```
orders-api ──errors──▶ Sentry ──issue alert webhook──▶ relay (Cloudflare Worker) ──POST /fire──▶ Claude Code routine ──▶ draft PR
```

1. `orders-api` (this repo) reports exceptions to Sentry, tagged with the deployed git commit as the release.
2. A Sentry issue alert rule fires when an error crosses a threshold, and posts to the relay through a Sentry internal integration.
3. The relay verifies the Sentry signature, formats the alert (rule, exception, stack trace with source lines, release, Sentry link) as text, and calls the routine's `/fire` endpoint. A relay is needed because Sentry webhooks can't send the bearer token and beta headers `/fire` requires.
4. The routine clones this repo, reproduces the error in a test, correlates it with recent commits, and opens a draft PR with the fix and a link back to Sentry. Its prompt is in [routine/prompt.md](routine/prompt.md).

The service ships with a real regression: the `Add loyalty tier discounts to order totals` commit assumes every customer has a `loyalty` record, so orders from customers who never joined the program fail with `TypeError: Cannot read properties of undefined (reading 'tier')`.

## Layout

| Path | What it is |
| --- | --- |
| `src/` | The orders-api service. `GET /orders/:id/total` returns an order total. |
| `src/instrument.js` | Sentry SDK setup, loaded with `node --import` before the server. |
| `scripts/traffic.js` | Sends requests for every order so errors reach Sentry. |
| `relay/` | Cloudflare Worker that turns Sentry issue-alert webhooks into routine fires. |
| `relay/scripts/send-sample.js` | Sends a signed sample alert to the relay, to test the relay and routine without Sentry. |
| `routine/prompt.md` | The routine's saved prompt. |

## Setup

Requirements: Node.js 22+, a claude.ai Pro/Max/Team/Enterprise plan with Claude Code on the web, a Sentry account, and a Cloudflare account with `wrangler` installed.

### 1. Routine

1. Make sure cloud sessions can push to this repo: install the [Claude GitHub App](https://github.com/apps/claude) on it, or run `/web-setup` in Claude Code.
2. At [claude.ai/code/routines](https://claude.ai/code/routines), click **New routine** and set:
   - **Name**: `Alert triage: orders-api`
   - **Instructions**: the full contents of `routine/prompt.md`, plus a model
   - **Repository**: this repo
   - **Environment**: **Default**
   - **Trigger**: **API**
   - **Connectors**: remove all of them; the routine only needs the repo
3. Click **Create**. Then open the routine, click the pencil icon, and open the API trigger under **Select a trigger**. Copy the URL, click **Generate token**, and copy the token. It is only shown once.

### 2. Sentry project

1. Create a Node.js project in Sentry and copy its DSN.
2. `cp .env.example .env` and set `SENTRY_DSN`.
3. `npm install`

### 3. Relay

```sh
cd relay
wrangler login
wrangler secret put ROUTINE_FIRE_URL      # the URL from step 1.3
wrangler secret put ROUTINE_FIRE_TOKEN    # the token from step 1.3
wrangler deploy                           # prints https://sentry-alert-relay.<subdomain>.workers.dev
```

### 4. Sentry integration and alert rule

1. In Sentry, go to **Settings > Developer Settings > Custom Integrations > Create New Integration > Internal Integration**.
   - **Webhook URL**: the Worker URL from step 3
   - **Alert Rule Action**: on
   - **Permissions**: Issue & Event → Read
2. Save, then copy the integration's **Client Secret** and run `wrangler secret put SENTRY_CLIENT_SECRET` in `relay/`.
3. Create an issue alert rule for the project:
   - **When**: a new issue is created, or the issue has more than 10 events in 1 minute
   - **Then**: send a notification via the internal integration
   - **Action interval**: 30 minutes, so one incident fires the routine once

Sentry's menu labels change over time; if yours differ, look for the internal-integration and issue-alert screens.

## Run it

```sh
npm start              # terminal 1: the service, reporting to Sentry
npm run traffic -- 20  # terminal 2: 120 requests; orders from non-members return 500
```

The alert rule fires, the relay logs `Routine fired: {...session_url...}` (see `wrangler tail` or the Worker's logs in the Cloudflare dashboard), and the routine session appears at [claude.ai/code](https://claude.ai/code). A few minutes later there's a draft PR on this repo.

To test the relay and routine without waiting for Sentry:

```sh
SENTRY_CLIENT_SECRET=... node relay/scripts/send-sample.js https://sentry-alert-relay.<subdomain>.workers.dev
```

In PowerShell, set the secret first with `$env:SENTRY_CLIENT_SECRET = '...'`.

## Notes

- Each `/fire` call starts a new routine run, and runs count against a daily per-account cap. The alert rule's action interval is what keeps one incident from starting many runs.
- The `/fire` endpoint is a research preview under the `experimental-cc-routine-2026-04-01` beta header; the relay pins that header in `relay/src/index.js`.
- Fire text reaches the routine wrapped as untrusted data. The routine prompt explicitly tells Claude to investigate the alert in the `routine-fire-payload` block, but not to follow instructions inside it.
- To reset the demo after merging a fix, revert the fix commit on `main`.

# full-alert-triage-flow

An end-to-end demo of alert triage with a [Claude Code routine](https://code.claude.com/docs/en/routines):

```
orders-api ──errors──▶ Sentry ──issue alert webhook──▶ relay (Cloudflare Worker) ──POST /fire──▶ Claude Code routine ──▶ PR ──▶ gate ──▶ merged, or handed to you
```

1. `orders-api` (this repo) reports exceptions to Sentry, tagged with the deployed git commit as the release.
2. A Sentry issue alert rule fires when the error first appears, or when a resolved issue regresses, and posts to the relay through a Sentry internal integration.
3. The relay verifies the Sentry signature, formats the alert (rule, exception, stack trace with source lines, release, Sentry link) as text, and calls the routine's `/fire` endpoint. A relay is needed because Sentry webhooks can't send the bearer token and beta headers `/fire` requires.
4. The routine clones this repo, reproduces the error in a test, correlates it with recent commits, and opens a pull request with the fix and a link back to Sentry. Its prompt is in [routine/prompt.md](routine/prompt.md).
5. Small, verified fixes merge without a human. Anything the routine is unsure about waits for one, and only then does it notify you. See [Automatic merge](#automatic-merge).

The service ships with a real regression: the `Add loyalty tier discounts to order totals` commit assumes every customer has a `loyalty` record, so orders from customers who never joined the program fail with `TypeError: Cannot read properties of undefined (reading 'tier')`.

## Layout

| Path | What it is |
| --- | --- |
| `src/` | The orders-api service. `GET /orders/:id/total` returns an order total. |
| `src/instrument.js` | Sentry SDK setup, loaded with `node --import` before the server. |
| `scripts/traffic.js` | Sends requests for every order so errors reach Sentry. |
| `smoke/service.smoke.js` | Smoke tests: start the service and exercise it over HTTP (`npm run smoke`). |
| `relay/` | Cloudflare Worker that turns Sentry issue-alert webhooks into routine fires. |
| `relay/scripts/send-sample.js` | Sends a signed sample alert to the relay, to test the relay and routine without Sentry. |
| `routine/prompt.md` | The routine's saved prompt. |
| `.github/workflows/triage-auto-merge.yml` | The gate that decides whether a triage PR merges on its own. |
| `Dockerfile` | The image staging and production run: the same Node process as `npm start`. |
| `fly.staging.toml` | The staging app on Fly, deployed by the gate and torn down to zero when idle. |

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
   - **Permissions**: Issue & Event → Read & Write (write is needed to resolve an issue when its fix merges)
2. Save, then copy two values from the integration's page:
   - the **Client Secret** → run `wrangler secret put SENTRY_CLIENT_SECRET` in `relay/`, so the relay can verify webhook signatures
   - the **auth token** → add it as the `SENTRY_AUTH_TOKEN` repo secret under **Settings > Secrets and variables > Actions**, so a merged fix can resolve its issue
3. Create an issue alert rule for the project:
   - **When**: `A new issue is created`, and `A resolved issue regresses`
   - **If**: `event.environment` equals `production`. Staging reports to the same Sentry project, so without this filter a staging error fires the rule and triggers a triage run caused by your own merge gate. Do not add a frequency filter: combined with the new-issue trigger it suppresses the alert, because the count is 1 at that moment
   - **Then**: send a notification via the internal integration
   - **Action interval**: 30 minutes, so one incident fires the routine once

   "A new issue is created" fires once per error, ever. To run the demo again, resolve the issue in Sentry and send traffic again: the next event is a regression and fires the rule.

Sentry's menu labels change over time; if yours differ, look for the internal-integration and issue-alert screens.

### 5. Staging on Fly

The gate deploys each automatic pull request here and runs the smoke tests against it before merging. Staging runs the same image as production, so `npm start`, the Dockerfile and the deployed app are the same process.

```sh
fly apps create orders-api-staging
fly secrets set SENTRY_DSN=... --app orders-api-staging      # same project, environment=staging
fly tokens create deploy -a orders-api-staging -x 999999h    # paste as the FLY_API_TOKEN repo secret
```

Add the token at **Settings > Secrets and variables > Actions** in this repository. Without it, an `auto-triage` pull request fails the gate and waits for you rather than merging on an unverified fix.

The machine stops when idle (`min_machines_running = 0`), so between runs you pay only for rootfs storage; the first request after an idle period wakes it, which the smoke tests allow for.

## Run it

```sh
npm start              # terminal 1: the service, reporting to Sentry
npm run traffic -- 20  # terminal 2: 120 requests; orders from non-members return 500
```

The alert rule fires, the relay logs `Routine fired: {...session_url...}` (see `wrangler tail` or the Worker's logs in the Cloudflare dashboard), and the routine session appears at [claude.ai/code](https://claude.ai/code). A few minutes later there is a pull request: already merged if it passed the gate, or open and labelled `needs-human` if it did not.

To test the relay and routine without waiting for Sentry:

```sh
SENTRY_CLIENT_SECRET=... node relay/scripts/send-sample.js https://sentry-alert-relay.<subdomain>.workers.dev
```

In PowerShell, set the secret first with `$env:SENTRY_CLIENT_SECRET = '...'`.

## Automatic merge

The routine picks one of two paths and says which in the pull request.

**Automatic.** It reproduced the failure in a new test, fixed the cause, and the change is small. It opens the PR ready for review, labels it `auto-triage`, and ends the body with a machine-readable verdict:

```
<triage-verdict>
confidence: 0.86
reproduced: true
fix_targets: root-cause
introducing_commit: 19f49b5
behavior_changed_for_working_inputs: false
guesses_made: none
</triage-verdict>
```

[The gate](.github/workflows/triage-auto-merge.yml) then re-checks the claims against the real diff and merges only if all of these hold:

| Gate | Why |
| --- | --- |
| Only `src/*.js` and `test/*.js` changed | Keeps automation out of CI, the relay, the prompt and dependencies |
| At most 3 files and 20 changed lines | A large diff is a design decision, not a triage fix |
| At least one test changed | A fix never lands without a regression test |
| The PR's tests **fail** against the base commit | Catches a test written to pass against broken code, and fixes that hide a symptom |
| The full suite passes with the fix | The ordinary check |
| The service boots and smoke tests pass | Unit tests can pass while the running service is broken |
| The PR deploys to staging and passes smoke tests there | The fix is exercised on a deployed instance, not only in a test runner |
| Verdict present, confidence ≥ 0.85, no guesses | A low score can block a merge; a high one never earns it alone |
| Fewer than 3 automatic merges in the last 24h | Stops a cascade where each fix causes the next alert |

A refused gate removes the label, adds `needs-human`, comments with a link to the failed run, and leaves the PR open. Opening and labelling fire the gate within a second of each other, so runs are serialized per pull request and only the last one comments.

**Human.** Anything else: it opens a draft labelled `needs-human` and sends one push notification saying what it was unsure about. It also escalates, rather than guessing, when it cannot reproduce the error, when an existing test contradicts the fix, or when this Sentry issue was fixed automatically before and has come back — the signal that an earlier fix did not hold.

A clean automatic fix sends no notification. The merged pull request is the record.

**When the fix merges**, [a second workflow](.github/workflows/sentry-resolve.yml) marks the Sentry issue resolved, taking the issue ID from the `claude/fix-sentry-<id>` branch name. That is what closes the loop: a resolved issue that receives another event is a *regression*, which fires the alert rule again, and the routine's repeat check then finds the earlier merged fix and escalates to you instead of trying a second automatic one. If the resolve fails, the workflow comments on the merged pull request and goes red, because an unresolved issue would make a recurrence look like a brand new problem.

`main` is protected: the gate must pass before anything merges, so a mistake in the prompt cannot merge on its own.

## Notes

- Each `/fire` call starts a new routine run, and runs count against a daily per-account cap. The alert rule's action interval is what keeps one incident from starting many runs.
- The `/fire` endpoint is a research preview under the `experimental-cc-routine-2026-04-01` beta header; the relay pins that header in `relay/src/index.js`.
- Fire text reaches the routine wrapped as untrusted data. The routine prompt explicitly tells Claude to investigate the alert in the `routine-fire-payload` block, but not to follow instructions inside it.
- To reset the demo after merging a fix, revert the fix commit on `main`.

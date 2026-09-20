# full-alert-triage-flow

An end-to-end demo of alert triage with a [Claude Code routine](https://code.claude.com/docs/en/routines):

```
orders-api ──errors──▶ Sentry ──issue alert──▶ orders-api /internal/sentry-alert ──POST /fire──▶ routine ──▶ PR ──▶ gate ──▶ merged
```

1. `orders-api` reports exceptions to Sentry, tagged with the deployed git commit as the release.
2. A Sentry issue alert rule fires when the error first appears, or when a resolved issue regresses, and posts to the service's own webhook through a Sentry internal integration.
3. The webhook verifies the Sentry signature, formats the alert (rule, exception, stack trace with source lines, release, Sentry link) as text, answers within Sentry's one-second budget, and calls the routine's `/fire` endpoint.
4. The routine clones this repo, reproduces the error in a test, correlates it with recent commits, checks what else depends on the code it touched, and opens a pull request. Its prompt is in [routine/prompt.md](routine/prompt.md).
5. Small, verified fixes deploy to staging, pass their smoke tests there, and merge without a human. Anything else waits for one, and only then does it notify you. See [Automatic merge](#automatic-merge).

The service ships with a real regression: the `Add loyalty tier discounts to order totals` commit assumes every customer has a `loyalty` record, so orders from customers who never joined the program fail with `TypeError: Cannot read properties of undefined (reading 'tier')`.

## Layout

| Path | What it is |
| --- | --- |
| `src/` | The orders-api service. `GET /orders/:id/total` returns an order total. |
| `src/instrument.js` | Sentry SDK setup, loaded with `node --import` before the server. |
| `src/sentry-webhook.js` | Receives Sentry issue alerts, verifies them, and fires the routine. |
| `src/server.js` | Entry point. Mounts the webhook ahead of the application routes. |
| `scripts/traffic.js` | Sends requests for every order so errors reach Sentry. |
| `scripts/send-sample.js` | Sends a signed sample alert, to test the webhook and routine without Sentry. |
| `smoke/service.smoke.js` | Smoke tests: exercise a running instance over HTTP (`npm run smoke`). |
| `routine/prompt.md` | The routine's saved prompt. |
| `Dockerfile` | The image both environments run: the same Node process as `npm start`. |
| `fly.toml`, `fly.staging.toml` | The production and staging apps on Fly. |
| `.github/workflows/` | The merge gate, and resolving the Sentry issue when a fix lands. |

`src/server.js` and `src/sentry-webhook.js` sit outside what an automatic fix may edit: they decide whether alerts reach the routine at all.

## Setup

Requirements: Node.js 22+, a claude.ai Pro/Max/Team/Enterprise plan with Claude Code on the web, a Sentry account, and a Fly account with `flyctl` installed.

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

Create a Node.js project in Sentry and copy its DSN. For local runs, `cp .env.example .env`, set `SENTRY_DSN`, then `npm install`.

### 3. Deploy both environments

Production holds the webhook and keeps one machine running, because Sentry times out after a second and a cold start would not make it. Staging scales to zero and is given no webhook secrets, so its endpoint returns 404 and it can never fire the routine.

```sh
flyctl auth login
flyctl apps create orders-api-prod
flyctl apps create orders-api-staging

flyctl secrets set --app orders-api-prod SENTRY_DSN=... ROUTINE_FIRE_URL=... ROUTINE_FIRE_TOKEN=...
flyctl secrets set --app orders-api-staging SENTRY_DSN=...

flyctl deploy --config fly.toml
flyctl deploy --config fly.staging.toml
```

`ROUTINE_FIRE_URL` and `ROUTINE_FIRE_TOKEN` are the URL and token from step 1.3. `SENTRY_CLIENT_SECRET` comes from step 4, once the integration exists.

Fly creates two machines per app for zero-downtime deploys. One is enough here, and halves the bill: `flyctl scale count 1 --app orders-api-prod`, likewise for staging.

The merge gate redeploys staging on every automatic pull request, so it needs a deploy token:

```sh
flyctl tokens create deploy -a orders-api-staging -x 999999h
```

Add that as the `FLY_API_TOKEN` repository secret under **Settings > Secrets and variables > Actions**. Without it, an `auto-triage` pull request fails the gate and waits for you rather than merging on an unverified fix.

### 4. Sentry integration and alert rule

1. In Sentry, go to **Settings > Developer Settings > Custom Integrations > Create New Integration > Internal Integration**.
   - **Webhook URL**: `https://orders-api-prod.fly.dev/internal/sentry-alert`
   - **Alert Rule Action**: on
   - **Permissions**: Issue & Event → Read & Write (write is needed to resolve an issue when its fix merges)
   - **Webhooks**: leave every box unchecked. Alert deliveries come from the Alert Rule Action, not from these
2. Save, then copy two values from the integration's page:
   - the **Client Secret** → `flyctl secrets set SENTRY_CLIENT_SECRET=... --app orders-api-prod`, so the webhook can verify signatures
   - the **auth token** → add it as the `SENTRY_AUTH_TOKEN` repo secret, so a merged fix can resolve its issue
3. Create an issue alert rule for the project:
   - **When**: `A new issue is created`, and `A resolved issue regresses`
   - **If**: `event.environment` equals `production`. Staging reports to the same project, so without this filter a staging error fires the rule and triggers a triage run caused by your own merge gate. Do not add a frequency filter: combined with the new-issue trigger it suppresses the alert, because the count is 1 at that moment
   - **Then**: send a notification via the internal integration
   - **Action interval**: 30 minutes, so one incident fires the routine once

Sentry's menu labels change over time; if yours differ, look for the internal-integration and issue-alert screens.

## Run it

Against production:

```sh
BASE_URL=https://orders-api-prod.fly.dev npm run traffic -- 1
```

One in three requests returns 500, the alert rule fires, and the routine session appears at [claude.ai/code](https://claude.ai/code). A few minutes later there is a pull request: already merged if it passed the gate, or open and labelled `needs-human` if it did not.

Locally, `npm start` in one terminal and `npm run traffic -- 1` in another does the same thing, provided `.env` has a DSN.

To exercise the webhook and the routine without waiting for Sentry:

```sh
SENTRY_CLIENT_SECRET=... node scripts/send-sample.js https://orders-api-prod.fly.dev
```

In PowerShell, set the secret first with `$env:SENTRY_CLIENT_SECRET = '...'`.

## Automatic merge

The routine picks one of two paths and says which in the pull request.

**Automatic.** It reproduced the failure in a new test, fixed the cause, checked everything that depends on what it touched, and the change is small. It opens the PR ready for review, labels it `auto-triage`, and ends the body with a machine-readable verdict:

```
<triage-verdict>
confidence: 0.86
reproduced: true
fix_targets: root-cause
introducing_commit: 19f49b5
behavior_changed_for_working_inputs: false
dependents_checked: src/app.js, test/pricing.test.js
guesses_made: none
</triage-verdict>
```

[The gate](.github/workflows/triage-auto-merge.yml) then re-checks the claims against the real diff and merges only if all of these hold:

| Gate | Why |
| --- | --- |
| Only `src/*.js` and `test/*.js` changed | Keeps automation out of CI, the prompt, the deploy config and dependencies |
| `src/server.js` and `src/sentry-webhook.js` untouched | A fix may not edit the code that decides whether alerts reach it |
| At most 3 files and 20 changed lines | A large diff is a design decision, not a triage fix |
| At least one test changed | A fix never lands without a regression test |
| The PR's tests **fail** against the base commit | Catches a test written to pass against broken code, and fixes that hide a symptom |
| The full suite passes with the fix | The ordinary check |
| The service boots and smoke tests pass | Unit tests can pass while the running service is broken |
| The PR deploys to staging and passes smoke tests there | The fix is exercised on a deployed instance, not only in a test runner |
| Verdict present, confidence ≥ 0.85, no guesses | A low score can block a merge; a high one never earns it alone |
| Fewer than 3 automatic merges in the last 24h | Stops a cascade where each fix causes the next alert |

A refused gate removes the label, adds `needs-human`, comments with a link to the failed run, and leaves the PR open. Opening and labelling fire the gate within a second of each other, so runs are serialized per pull request and only the last one comments.

**Human.** Anything else: it opens a draft labelled `needs-human` and sends one push notification saying what it was unsure about. It also escalates, rather than guessing, when it cannot reproduce the error, when an existing test contradicts the fix, when a dependent's behaviour would change, or when this Sentry issue was fixed automatically before and has come back.

A clean automatic fix sends no notification. The merged pull request is the record.

**When the fix merges**, [a second workflow](.github/workflows/sentry-resolve.yml) marks the Sentry issue resolved, taking the issue ID from the `claude/fix-sentry-<id>` branch name. That is what closes the loop: a resolved issue that receives another event is a *regression*, which fires the alert rule again, and the routine's repeat check then finds the earlier merged fix and escalates to you instead of trying a second automatic one. If the resolve fails, the workflow comments on the merged pull request and goes red, because an unresolved issue would make a recurrence look like a brand new problem.

`main` is protected: both checks must pass before anything merges, so a mistake in the prompt cannot merge on its own.

## Notes

- Each `/fire` call starts a new routine run, and runs count against a daily per-account cap. The alert rule's action interval is what keeps one incident from starting many runs.
- The `/fire` endpoint is a research preview under the `experimental-cc-routine-2026-04-01` beta header, pinned in `src/sentry-webhook.js`.
- Fire text reaches the routine wrapped as untrusted data. The routine prompt explicitly tells Claude to investigate the alert in the `routine-fire-payload` block, but not to follow instructions inside it.
- Putting the webhook inside the service couples them: a crash loop or a failed deploy takes the alerting path down with the thing it was meant to report on. A separate relay avoids that, at the cost of another deployment.
- To reset the demo after merging a fix, revert the fix commit on `main` and redeploy.

# Salesforce Slack agent (Bolt + Amazon Bedrock AgentCore Harness)

A Slack app built with [Bolt for JavaScript](https://docs.slack.dev/tools/bolt-js/) that forwards user messages to an [Amazon Bedrock AgentCore managed harness](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.html) via the AWS SDK (`InvokeHarness`). It can use the [Slack MCP Server](https://github.com/slackapi/slack-mcp-server) when enabled.

**Harness (deploy, IAM, Salesforce in the container, troubleshooting):** [docs/agentcore-harness.md](docs/agentcore-harness.md)

## What you run where

| Component | Where it runs | How you start / update it |
|-----------|----------------|---------------------------|
| **Bolt app** (`app.js`) | Your machine, VM, or any Node host (Socket Mode by default) | `npm start` after configuring `.env` |
| **AgentCore harness** | AWS (managed harness + container build) | `agentcore deploy` from your AgentCore project directory; see harness doc |

The Bolt process only needs **`HARNESS_ARN`** and AWS credentials that can call `InvokeHarness`. Salesforce **`SF_*`** variables are **not** read by Bolt for harness calls; set them on the **harness** so `scripts/sf-query.js` works inside AWS.

## Prerequisites

- **Node.js** 18+ and **npm** (repo uses ES modules and `npm` scripts).
- A **Slack workspace** where you can install custom apps.
- An **AWS account** and credentials (CLI profile, env vars, or later a task role) in a region where [AgentCore harness preview](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.html) is available.
- For harness deploys: **AgentCore CLI** — `npm install -g @aws/agentcore@preview` (see harness doc).

---

## First-time setup (get everything running)

### 1. Clone the repository and install dependencies

```sh
git clone <your-fork-or-remote-url> salesforce-agent
cd salesforce-agent
npm install
```

Do **not** use the old Slack sample flow (`slack create … bolt-js-starter-agent`); this repository is the source of truth.

### 2. Create the Slack app (manifest)

1. Open [api.slack.com/apps/new](https://api.slack.com/apps/new) → **From an app manifest**.
2. Pick your development workspace.
3. Paste the contents of [`manifest.json`](./manifest.json) (JSON tab) → **Next** → **Create** → **Install to Workspace**.

Current manifest uses **Socket Mode** (`socket_mode_enabled: true`). The **Home tab is disabled**; the app uses the **Messages** tab under the app in Slack’s sidebar.

4. Collect tokens for `.env` (next step):
   - **OAuth & Permissions** → **Bot User OAuth Token** → `SLACK_BOT_TOKEN`
   - **Basic Information** → **App-Level Tokens** → create a token with scope **`connections:write`** → `SLACK_APP_TOKEN`

### 3. Configure `.env`

```sh
cp .env.sample .env
```

Edit `.env` and set at least:

| Variable | Required for Bolt? | Notes |
|----------|-------------------|--------|
| `SLACK_BOT_TOKEN` | Yes | `xoxb-…` |
| `SLACK_APP_TOKEN` | Yes | `xapp-…` (Socket Mode) |
| `HARNESS_ARN` | Yes | After you deploy a harness (step 4), paste the harness ARN here. |
| `AWS_REGION` | If not inferable | Usually matches the region embedded in `HARNESS_ARN`. |
| `SF_*` | No for Bolt | Used by **`sf-query.js` on the harness**, not by `InvokeHarness` from Bolt. Configure `SF_*` in AgentCore / AWS for the harness; keep in `.env` only if you run local Salesforce scripts. |

See [`.env.sample`](.env.sample) for the full list.

### 4. Deploy an AgentCore harness and set `HARNESS_ARN`

Pick **one** path:

**Path A — In-repo AgentCore project (`salesforceAgent00/`)**  
If this clone includes [`salesforceAgent00/`](./salesforceAgent00/) with `agentcore/agentcore.json`:

```sh
# From repo root: copy Dockerfile, package files, sf-query into the harness bundle path
./scripts/sync-harness-build-to-agentcore.sh ./salesforceAgent00

cd salesforceAgent00
agentcore validate   # optional
agentcore deploy
```

After deploy succeeds, copy the **harness ARN** from the CLI output or AWS console into **`HARNESS_ARN`** in `.env`.

**Path B — New directory from `agentcore create`**  
Follow the wizard in [docs/agentcore-harness.md](docs/agentcore-harness.md#one-time-harness-setup-cli): use **Harness**, point the Dockerfile at this repo’s [`agentcore-harness/Dockerfile`](./agentcore-harness/Dockerfile), deploy from **inside** the folder the CLI created, then set `HARNESS_ARN` in `.env`.

Ensure the IAM principal you use for `npm start` can call **`bedrock-agentcore:InvokeHarness`** and **`bedrock-agentcore:InvokeAgentRuntime`** on that harness (see harness doc).

### 5. Start the Bolt app

```sh
npm start
```

You should see a log line that the agent is running. In Slack, open the app (**Apps** → **salesforce-agent**), use **Messages**, DM the bot, or @mention **`@salesforce-agent`** in a channel.

---

## After you change something (updates and re-run)

Use this table to see what to redo:

| You changed… | What to do |
|----------------|------------|
| **Bolt code** (`listeners/`, `agent/`, `app.js`, etc.) | `git pull` if needed, `npm install` if `package.json` changed, **stop** the Node process (Ctrl+C) and run **`npm start`** again. No harness redeploy unless you changed the **InvokeHarness contract** (payload shape, session rules). |
| **`.env`** (tokens, `HARNESS_ARN`, AWS) | Edit `.env`, restart **`npm start`**. |
| **Slack manifest** (scopes, events, Socket Mode) | Update [`manifest.json`](./manifest.json), then in [App settings](https://api.slack.com/apps) use **App Manifest** → paste → save. Slack may require **reinstall** or token refresh depending on the change. |
| **Harness container** ([`agentcore-harness/`](./agentcore-harness/), [`scripts/sf-query.js`](./scripts/sf-query.js), harness `Dockerfile` under `salesforceAgent00/app/...`) | From repo root: `npm run sync:agentcore-harness`, then `./scripts/sync-harness-build-to-agentcore.sh <path-to-agentcore-project>`, then **`agentcore deploy`** from that project directory. Restart Bolt only if `HARNESS_ARN` changed. |
| **Harness config only** (model in `harness.json`, memory, tools in AgentCore JSON) | Edit files under the AgentCore project, **`agentcore deploy`**. Usually no Bolt code change. |
| **System prompt / Salesforce wording for the model** | Edit [`agent/system-instructions.js`](./agent/system-instructions.js) (what Bolt sends to the harness). Keep in sync with [`.cursor/rules/salesforce-agent.md`](./.cursor/rules/salesforce-agent.md). Restart **`npm start`**. |

**Lint / tests before commit:**

```sh
npm run lint
npm test
```

---

## Running a second bot (parallel with production)

Slack **Socket Mode** allows **one active WebSocket per Slack app**. Two processes with the same `SLACK_APP_TOKEN` / `SLACK_BOT_TOKEN` will interfere.

1. Create another app from [`manifest.dev.json`](./manifest.dev.json) (different display name than production).
2. Install it and copy **Bot** + **App-level** tokens into **`.env.dev`** (copy from [`.env.dev.sample`](./.env.dev.sample)).
3. Run **`npm run start:dev`** (loads `.env.dev`). Keep production on **`.env`** + **`npm start`**.

Details and optional second harness: [docs/agentcore-harness.md](docs/agentcore-harness.md#slack-parallel-dev-bot-socket-mode).

---

## Development entry points

### Default: Socket Mode (`app.js`)

```sh
npm start
```

Loads **`.env`** unless you set `DOTENV_CONFIG_PATH` (see `start:dev` in [`package.json`](./package.json)).

### Optional: Slack CLI

If you use the [Slack CLI](https://docs.slack.dev/tools/slack-cli/guides/installing-the-slack-cli-for-mac-and-linux/):

```sh
slack login
slack run
```

Run from the **repository root** after `.env` is configured. This does **not** replace cloning this repo; it is an alternative runner.

### Optional: OAuth HTTP mode (`app-oauth.js`)

For distribution via OAuth over HTTPS instead of Socket Mode, use ngrok (or similar), set `socket_mode_enabled` to `false` and your public URLs in the manifest, add `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, `SLACK_REDIRECT_URI` to `.env`, then:

```sh
node app-oauth.js
```

Or `slack run app-oauth.js` if your Slack CLI project is set up for it. Full ngrok / manifest steps are unchanged in spirit from the Slack template: update **`manifest.json`** request URLs, reinstall the app when the URL changes, and use the install link printed by `app-oauth.js`.

Default **HTTP port** is **3000** (`PORT` env overrides). Use a different `PORT` if another process already binds 3000.

---

## Using the app (Slack UX)

- **App entry** — In Slack, open **Apps** → **salesforce-agent**. With the current manifest, the **Home tab is off**; use the **Messages** tab to chat. (If you enable the Home tab later, `app_home_opened` can publish a welcome view from [`listeners/events/app-home-opened.js`](./listeners/events/app-home-opened.js).)
- **Direct messages** — DM the bot; it replies in the thread. Follow-ups in the same thread keep harness session context (see [`thread-context/store.js`](./thread-context/store.js)).
- **Channels** — Invite the bot if needed (`/invite @salesforce-agent`), then **`@salesforce-agent`** with your question; it responds in a thread.
- **Assistant** — **Add agent** → choose this app → suggested prompts are **Salesforce-oriented** (see [`listeners/events/assistant-thread-started.js`](./listeners/events/assistant-thread-started.js)), not generic “Write a message” placeholders.

### Slack MCP (optional)

When connected to the [Slack MCP Server](https://github.com/slackapi/slack-mcp-server), extra Slack-side tools may be available. **OAuth HTTP mode** can attach the user’s token for MCP. Enable **Slack Model Context Protocol** in the app’s **Agents & AI Apps** settings if Slack reports the app is not MCP-enabled (see [Troubleshooting](#mcp-server-connection-error-app-is-not-enabled-for-slack-mcp-server-access)).

---

## Project structure

### `manifest.json` / `manifest.dev.json`

Slack app definitions. Production-style app: [`manifest.json`](./manifest.json). Second app for dev: [`manifest.dev.json`](./manifest.dev.json).

### `app.js` / `app-oauth.js`

- **`app.js`** — Default entry: Socket Mode Bolt app.
- **`app-oauth.js`** — HTTP + OAuth entry for distributable installs.

### `listeners/`

- **`listeners/events`** — `message.js` (DM / engaged threads), `app-mentioned.js`, `assistant-thread-started.js`, `app-home-opened.js`.
- **`listeners/actions`** — `feedback-buttons.js`.
- **`listeners/views`** — Block Kit builders for app home and feedback.

### `agent/`

[`agent/agent.js`](./agent/agent.js) — `runAgent()` → [`agent/harness-client.js`](./agent/harness-client.js) (`InvokeHarness`). System copy in [`agent/system-instructions.js`](./agent/system-instructions.js).

### `thread-context/`

[`thread-context/store.js`](./thread-context/store.js) — In-memory map of Slack thread → harness runtime session id (TTL ~24h, capped entries).

### `salesforceAgent00/`

Optional **in-tree AgentCore project** (JSON + CDK + `app/sfHarness00`). Deploy with **`agentcore deploy`** from that directory after syncing the harness build (see harness doc and scripts above).

---

## Linting and tests

```sh
npm run lint
npm run lint:fix
npm test
npm run check    # Typecheck of app.js (JS)
```

---

## Troubleshooting

### MCP Server connection error: `App is not enabled for Slack MCP server access`

1. [api.slack.com/apps](https://api.slack.com/apps) → your app → **Agents & AI Apps**.
2. Turn **Slack Model Context Protocol** (or equivalent MCP toggle) **on**.

### Harness / deploy errors

See [docs/agentcore-harness.md](docs/agentcore-harness.md) (CodeBuild logs, Docker `COPY`, stack rollback, harness name length).

### Developer Program (optional)

[Slack Developer Program](https://api.slack.com/developer-program) — optional sandbox workspaces and resources.

# Amazon Bedrock AgentCore Harness with this Slack app

This repository’s Slack bot forwards user messages to an **AgentCore managed harness** using the AWS SDK (`InvokeHarness`). There is no Cursor Cloud Agent or Cursor API key involved at runtime.

## How it fits together

1. A user writes in Slack (DM, thread, or @mention).
2. The Bolt app calls `runAgent()` in [`agent/agent.js`](../agent/agent.js).
3. The app derives a **runtime session id** per Slack thread (stable hash of `channelId` + `threadTs`) so the harness can keep multi-turn context in the same microVM session when AWS still has that session alive.
4. The app calls **`InvokeHarness`** with your harness ARN, the session id, a **system prompt** (Slack formatting + Salesforce guidance), and the user message.
5. The SDK returns a **stream** of events; the client accumulates **text deltas** and returns the final markdown string to Slack.

Official references:

- [AgentCore harness (preview)](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.html)
- [Get started with the harness CLI](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-get-started.html)
- [InvokeHarness API](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeHarness.html)

## Environment variables (Slack / Bolt process)

These live in **`.env`** at the **salesforce-agent** repo root (or **`.env.dev`** for a second Slack app). They are **not** uploaded to AWS when you invoke the harness.

| Variable | Purpose | Where to get it |
|----------|---------|-----------------|
| `SLACK_BOT_TOKEN` | Authenticates the bot for Web API calls (`xoxb-…`). | [api.slack.com/apps](https://api.slack.com/apps) → your app → **OAuth & Permissions** → **Bot User OAuth Token** (install/reinstall the app if missing). |
| `SLACK_APP_TOKEN` | Enables **Socket Mode** (`xapp-…`). | Same app → **Basic Information** → **App-Level Tokens** → **Generate** → scope **`connections:write`**. |
| `HARNESS_ARN` | Target for **`InvokeHarness`**. | After **`agentcore deploy`**: deploy logs, **`agentcore status`** in the AgentCore project dir, or **[AWS Console → Amazon Bedrock](https://console.aws.amazon.com/bedrock/)** → AgentCore / harness resource. Format: `arn:aws:bedrock-agentcore:<region>:<account>:harness/<id>`. |
| `AWS_REGION` | Bedrock AgentCore client region if not inferable from the ARN. | Usually the region embedded in `HARNESS_ARN`. |
| `HARNESS_RUNTIME_SESSION_SALT` | Optional string mixed into the per-thread session hash. | Bump after credential / env changes if the harness still behaves like an old session (see [Runtime session id rules](#runtime-session-id-rules)). |

Step-by-step for Slack + ARN together: [README.md — Slack tokens and HARNESS_ARN](../README.md#slack-tokens-and-harness-arn). Copy [`.env.sample`](../.env.sample) to `.env` and fill the placeholders.

The Slack host only needs credentials to call **AWS** (profile, env keys, or ECS/Lambda task role).

## Salesforce credentials for the harness

Salesforce **JWT** variables (`SF_CLIENT_ID`, `SF_USERNAME`, `SF_PRIVATE_KEY` or `SF_PRIVATE_KEY_BODY`, optional `SF_LOGIN_URL`) must be present **inside the harness container** so [`scripts/sf-query.js`](../scripts/sf-query.js) can run. Bolt’s **`.env` is never sent to the harness** on invoke.

1. Copy [`.env.harness.sample`](../.env.harness.sample) to **`.env.harness`** in the repo root or next to your AgentCore project (`salesforceAgent00/.env.harness` is also read).
2. Fill the same values you would use for a Connected App JWT integration (consumer key, integration user username, and a private key). **Do not put an unquoted multiline PEM on one line per dotenv rules** — only the first line would be read, `harness.json` would get a truncated key, and Salesforce JWT would fail. Prefer **`SF_PRIVATE_KEY_BODY`** (one line), **`SF_PRIVATE_KEY_FILE`**, or a **double-quoted** multiline `SF_PRIVATE_KEY` (see the sample file).
3. From the **salesforce-agent** repo root: **`npm run merge-harness-env`** (or **`npm run merge-harness-env -- /path/to/agentcore-project`** if the project is not `./salesforceAgent00`). This writes **`harness.json` → `environmentVariables`** (see [AWS: Environment variables](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-environment.html)).
4. Run **`agentcore deploy`** from the AgentCore project directory.
5. From the **repo root** again: **`npm run push-harness-env`** (calls **`bedrock-agentcore-control:UpdateHarness`** with the same `environmentVariables` map). This step is **required** in many setups: infrastructure deploy can update the image/role without applying `harness.json` env to the live harness, so `sf-query` would see empty `SF_*` until you push.
6. Optionally **`npm run merge-harness-env -- --clear`** to strip secrets from local `harness.json` before `git commit` (re-run steps 3 and 5 when SF secrets change).

More context: [agentcore-harness/README.md](../agentcore-harness/README.md) and the root README [Path A / Path B](../README.md#4-deploy-an-agentcore-harness-and-set-harness_arn).

### Debug `sf-query.js`

1. **Same env as the harness, on your laptop** — from repo root: **`npm run debug-sf-query`** (optional SOQL after `--`, in quotes if it contains spaces). This loads **`salesforceAgent00/.../harness.json` → `environmentVariables`**, sets **`SF_QUERY_DEBUG=1`**, and runs **`scripts/sf-query.js`**. You see **`[sf-query]`** JSON lines on **stderr** and the normal SOQL JSON on **stdout** — same terminal.

2. **Inside the deployed harness** — add **`SF_QUERY_DEBUG=1`** to **`.env.harness`**, run **`npm run merge-harness-env`**, **`npm run push-harness-env`**, and redeploy the image if `sf-query.js` changed. Tool stderr is **not** shown in the Bolt terminal; open **CloudWatch** (or your AgentCore / runtime log sink) for the harness **session / tool execution** logs and filter for **`[sf-query]`**.

### Slack: parallel dev bot (Socket Mode)

Slack **Socket Mode** allows **one active WebSocket connection per Slack app**. Running two `npm start` processes with the same `SLACK_APP_TOKEN` / `SLACK_BOT_TOKEN` will disconnect or race. To run this repo alongside a production bot (e.g. from `main`), create a **second Slack app** from [`manifest.dev.json`](../manifest.dev.json), copy [`.env.dev.sample`](../.env.dev.sample) to `.env.dev`, fill in that app’s tokens, and run **`npm run start:dev`**. Keep production on `.env` + **`npm start`**. Set `HARNESS_ARN` in `.env.dev` to the same harness as production or, if you deploy a separate AgentCore stack, to that harness’s ARN (you may use a distinct [`agentcore.json`](../salesforceAgent00/agentcore/agentcore.json) `name` so deploys do not overwrite the other stack).

## IAM for the Slack app caller

The principal that runs Bolt (human laptop, ECS task role, etc.) must be allowed to invoke the harness. AWS documents that **`InvokeHarness` requires both**:

- `bedrock-agentcore:InvokeHarness`
- `bedrock-agentcore:InvokeAgentRuntime`

on the harness resource. See [Security and access controls](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-security.html).

Start from managed policies only in sandboxes; use least-privilege policies in production.

For **`npm run push-harness-env`**, the IAM principal also needs **`bedrock-agentcore:UpdateHarness`** on the harness resource (or `*` in sandboxes) so the control plane accepts the `environmentVariables` map from `harness.json`.

## Harness execution role and Salesforce

The managed harness runs in an isolated environment. To run `node scripts/sf-query.js` as documented in [`.cursor/rules/salesforce-agent.md`](../.cursor/rules/salesforce-agent.md), you typically:

1. **Custom container (recommended for parity)** — This repo includes [`agentcore-harness/Dockerfile`](../agentcore-harness/Dockerfile) (linux/arm64, Node 22, `scripts/sf-query.js` + prod dependencies). When `agentcore create` asks for the Dockerfile path, from the **salesforce-agent** repo root enter **`agentcore-harness/Dockerfile`** (or an absolute path to that file). Set `SF_*` on the harness, not in the image. See [Environment and Skills](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-environment.html) and [agentcore-harness/README.md](../agentcore-harness/README.md).

   **Important:** use **[Salesforce credentials for the harness](#salesforce-credentials-for-the-harness)** (`merge-harness-env` + deploy), not Slack’s `.env`, for `SF_*`.

2. **AgentCore Gateway / MCP** — Expose SOQL or data access as tools and attach them to the harness; tighter coupling to AWS, less “run arbitrary shell” surface.

The **system instructions** sent from the Slack app are duplicated in [`agent/system-instructions.js`](../agent/system-instructions.js); keep them aligned with `.cursor/rules` when you change behavior.

## Runtime session id rules

`X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` must match `[a-zA-Z0-9][a-zA-Z0-9-_]*` and length constraints (see API). Slack `thread_ts` contains `.`, so this app uses `deriveRuntimeSessionId()` — a **`s` + SHA-256 hex** string (65 characters). Legacy Cursor agent ids in the in-memory store are ignored when invalid, and the derived id is written back after a successful reply.

**Stale sessions after `push-harness-env`:** AgentCore can keep a **hot** runtime session for the same id. That session may have started **before** `SF_*` existed on the harness, so `sf-query` still sees empty env even though **GetHarness** (printed at the end of **`npm run push-harness-env`**) shows correct key lengths. Fix either: start a **new Slack assistant thread / DM**, or set **`HARNESS_RUNTIME_SESSION_SALT`** in Bolt’s `.env` to a new value (e.g. bump `v1` → `v2`), restart **`npm start`**, and retry in the same thread.

## One-time harness setup (CLI)

Install the preview CLI (from [AWS harness get started](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-get-started.html)):

```bash
npm install -g @aws/agentcore@preview
```

### Interactive wizard (recommended)

The AgentCore CLI only walks you through **Harness vs Runtime, Dockerfile path, memory, tools,** etc. in **interactive** mode. Any flag marked as non-interactive (including passing **`--name`** or **`--model-provider`**) switches to **scripted mode**, which skips those prompts and scaffolds with defaults instead.

Run **either**:

```bash
agentcore create
```

with **no arguments**, **or** launch the full terminal UI:

```bash
agentcore
```

and choose create from there. In the wizard, pick **Harness**, **Bedrock**, **custom environment**, then point the Dockerfile question at this repo’s file, for example:

`../salesforce-agent/agentcore-harness/Dockerfile`

if your new project sits next to this repo, **or** an absolute path to [`agentcore-harness/Dockerfile`](../agentcore-harness/Dockerfile).

### Where `deploy` and `dev` run

`agentcore create` writes a **new project directory** (for example `mysalesforceagent/`) containing `agentcore/agentcore.json`, CDK, and generated app code. **Always run `agentcore deploy`, `agentcore dev`, and `agentcore invoke` from inside that directory**, not from the `salesforce-agent` repo root:

```bash
cd mysalesforceagent
agentcore deploy
```

The Slack Bolt app in `salesforce-agent` stays separate: after deploy, copy the harness **ARN** into `HARNESS_ARN` in this repo’s `.env`.

### Docker build failed in CodeBuild (`COPY … not found`)

AgentCore uploads the **harness bundle** for the directory in `agentcore/agentcore.json` → `harnesses[0].path` (for example `app/sfHarness00`), **not** the whole git repo and not necessarily the AgentCore project root. The Docker build context is **that folder**, so `COPY package.json` / `COPY scripts/...` must exist **inside it**.

### Harness name length (API `400` validation)

The control plane builds a harness identifier like `{projectName}_{harnessName}`. It must match **`[a-zA-Z][a-zA-Z0-9_]{0,39}`** — at most **40 characters** total. Long project + harness names (for example `salesforceAgent00_salesForceAgentHarness00`) exceed that and return **`400` validation error**. Fix by shortening **`harnesses[].name`** (and matching `harness.json` / app folder) or the **project `name`** in `agentcore.json`.

**Fix:** from the `salesforce-agent` repo run:

```bash
./scripts/sync-harness-build-to-agentcore.sh /path/to/your-agentcore-project
```

The script reads `harnesses[0].path` and copies `Dockerfile`, `package.json`, `package-lock.json`, and `scripts/sf-query.js` into that directory. Then `cd` the AgentCore project and run `agentcore deploy` again. See [`agentcore-harness/README.md`](../agentcore-harness/README.md).

### CodeBuild: `429 Too Many Requests` pulling `node:…` from Docker Hub

If CloudWatch / CodeBuild shows:

`unexpected status from GET request to https://registry-1.docker.io/... 429 Too Many Requests`  
`toomanyrequests: You have reached your unauthenticated pull rate limit`

CodeBuild is pulling **`docker.io/library/node`** anonymously and Docker Hub throttled the account/IP. **Fix:** base the image on **[AWS Public ECR’s copy of the official Node image](https://gallery.ecr.aws/docker/library/node)** instead of Docker Hub, for example:

`FROM public.ecr.aws/docker/library/node:22-bookworm-slim`

This repo’s [`agentcore-harness/Dockerfile`](../agentcore-harness/Dockerfile) uses that `FROM`. Re-run [`scripts/sync-harness-build-to-agentcore.sh`](../scripts/sync-harness-build-to-agentcore.sh) into your AgentCore project, then deploy again.

(Alternatives: Docker Hub paid login inside CodeBuild, or vendor a base image into your own ECR.)

### Reading `deploy-*.log` when CloudFormation says “CodeBuild build failed”

Deploy logs under `agentcore/.cli/logs/deploy/` only show **CloudFormation events**. The line:

`CodeBuild build failed … Logs: https://console.aws.amazon.com/cloudwatch/...`

means the **container image build** step failed. Open that **CloudWatch → CodeBuild** log stream to see the real error (for example `COPY` missing files, `npm ci` lockfile mismatch, or `exec format error` for wrong CPU architecture).

After a failed deploy, the stack can sit in **`ROLLBACK_COMPLETE`**. CDK may delete and recreate it on the next run (see your log around “Deleting … before attempting to re-create”). If deploy still complains about the stack, delete it manually:  
`aws cloudformation delete-stack --stack-name AgentCore-<project>-default --region <region>`  
then deploy again.

### Fully non-interactive alternative

If you need CI or a repeatable script, use flags only (no prompts), per `agentcore help create` and [upstream command docs](https://github.com/aws/agentcore-cli/blob/main/docs/commands.md). That path requires supplying every option you care about on the command line (or accepting `--defaults`).

### Local iteration

```bash
cd mysalesforceagent
agentcore dev
```

Use the agent inspector to validate prompts and tools before wiring Slack.

### Wizard cheat sheet (Tools, Authentication, Network, …)

Use this for a **first working** Slack + Salesforce harness; add complexity only when you have a concrete requirement.

| Area | What to choose | Why |
|------|----------------|-----|
| **Tools** (Browser, Code Interpreter, Gateway, MCP, …) | **Skip / none** at first | Your [`agentcore-harness/Dockerfile`](../agentcore-harness/Dockerfile) already has **Node** and **`scripts/sf-query.js`**. The harness can run **shell** in the session for SOQL. Add **Browser** only if the agent must drive the web. Add **Code Interpreter** only if you want AWS’s managed Python sandbox in addition to your image. Add **Gateway / MCP** when you move Salesforce behind a proper tool API instead of `sf-query.js`. |
| **Authentication** (inbound OAuth, Identity, …) | **Skip inbound OAuth** for the first setup | The Slack app calls `InvokeHarness` with **IAM (SigV4)**. That path does **not** propagate each Slack user into AgentCore Identity the way a **Bearer JWT** inbound flow does ([harness security](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-security.html)). Turn on inbound OAuth later only if tools must use **per-user** tokens (e.g. Salesforce as the end user). |
| **Execution role** (Bedrock, logs, ECR, …) | **Accept what the wizard / CDK generates**, then tighten | The role must let the harness **invoke your Bedrock model**, **pull your image from ECR** (if applicable), and **write logs/traces**. Follow AWS’s [harness execution role policy](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-security.html#harness-execution-role-policy) when you trim permissions. |
| **Network** | **Public** first | Salesforce and Bedrock public endpoints work from the default harness network. Pick **VPC** only if login/API traffic must go through **private connectivity** (corporate proxy, IP restrictions, private Salesforce integrations). You will need **subnets** and **security groups** with egress to Salesforce HTTPS and the Bedrock / AgentCore endpoints your org uses. |
| **Memory** | **None** or **short-term** | **Short-term** helps within a live harness session. This repo already sends a stable **`runtimeSessionId` per Slack thread** so turns in the same thread reuse the same harness session when AWS still has it. Use **long-term** AgentCore Memory only if you need knowledge across sessions beyond Slack threading. |
| **Model** | A Bedrock model you are **allowed to use in that region** | Start with a smaller/cheaper model for wiring and tests; switch to a larger model once everything works. |
| **Limits** (iterations, timeouts, tokens) | **Defaults** | Increase only if the agent legitimately needs more time; decrease if runs are too slow or expensive. |

If a prompt is unclear, prefer **the smallest option** (no extra tools, public network, no OAuth). You can **`agentcore deploy` again** after editing `agentcore/agentcore.json` (or the wizard’s follow-up `add` commands) when you add Browser, VPC, or Gateway later.

## Deploy and update

### In-repo AgentCore project (`salesforceAgent00/`)

This repository may include [`salesforceAgent00/`](../salesforceAgent00/) (an AgentCore project with `agentcore/agentcore.json` and CDK). To build and deploy that harness from a clean clone:

1. From the **salesforce-agent** repo root:  
   `./scripts/sync-harness-build-to-agentcore.sh ./salesforceAgent00`  
   (copies [`agentcore-harness/`](../agentcore-harness/) artifacts into `harnesses[0].path` — see script and [`agentcore-harness/README.md`](../agentcore-harness/README.md).)
2. **[Salesforce for the harness](#salesforce-credentials-for-the-harness):** `.env.harness` → **`npm run merge-harness-env`** (optional **`--clear`** after deploy if you stripped secrets from `harness.json` earlier).
3. `cd salesforceAgent00` → `agentcore validate` (optional) → **`agentcore deploy`**.
4. From repo root: **`npm run push-harness-env`** so AWS **`UpdateHarness`** applies `environmentVariables`.
5. Put the harness **ARN** in the Bolt app’s **`.env`** as **`HARNESS_ARN`** and restart **`npm start`** (see [README — Slack tokens and HARNESS_ARN](../README.md#slack-tokens-and-harness-arn)).

### What to redeploy when something changes

| Change | Action |
|--------|--------|
| Harness **Dockerfile**, `package.json` / lockfile, or `scripts/sf-query.js` under the synced harness path | `npm run sync:agentcore-harness` (updates [`agentcore-harness/`](../agentcore-harness/) from canonical [`scripts/sf-query.js`](../scripts/sf-query.js)), then `./scripts/sync-harness-build-to-agentcore.sh <agentcore-project>`, then **`agentcore deploy`** from that project. |
| Harness **model / tools / memory** in `harness.json` or `agentcore.json` | Edit those files, **`agentcore deploy`**. |
| **Bolt** Slack code (`listeners/`, `agent/`, `app.js`) | Restart the Node process; **no** harness deploy unless you changed the harness API contract. |
| **Slack system prompt** sent to the model (`agent/system-instructions.js`) | Restart Bolt only. |
| **Secrets** (`SF_*`) for Salesforce inside the harness | **`.env.harness`** → **`merge-harness-env`** → **`agentcore deploy`** → **`push-harness-env`** (see [Salesforce credentials for the harness](#salesforce-credentials-for-the-harness)). Optionally **`merge-harness-env -- --clear`** locally after deploy. Avoid committing populated `harness.json`. |

### Bolt app on AWS

This repo does **not** ship IaC for the Bolt process. You run Bolt wherever you host Node (laptop, ECS, EC2, etc.). Only the **harness** is provisioned by AgentCore CDK from the AgentCore project directory.

## Ongoing operations

- **Logs and traces**: use `agentcore logs`, `agentcore traces`, and CloudWatch for the harness and runtime. See CLI help and [Observability](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability.html) in the AgentCore docs.
- **Costs**: Bedrock model usage, harness session compute, and any attached tools (browser, code interpreter, etc.) bill separately. Terminate idle sessions where possible.
- **Throttling / errors**: implement retries with backoff for `ThrottlingException`; surface `ValidationException` messages to operators.
- **Session TTL**: Bolt’s in-memory [`SessionStore`](../thread-context/store.js) uses a 24h TTL; harness sessions on AWS have their own idle and max lifetime — see AgentCore Runtime session documentation linked from the harness guide.

## Regions

Harness preview is available in **US East (N. Virginia), US West (Oregon), Europe (Frankfurt), and Asia Pacific (Sydney)**. Deploy the harness in one of these regions and run the Slack app with credentials that can call that region.

## Optional hardening

- **Inbound OAuth** on the harness if tools must act per Slack user ([harness security](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-security.html)).
- **VPC** for the harness if Salesforce or other backends are only reachable privately.

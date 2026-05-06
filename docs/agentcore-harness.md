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

Salesforce **JWT** material must reach [`scripts/sf-query.js`](../scripts/sf-query.js) **inside the harness**. Bolt’s **`.env` is never sent** on `InvokeHarness`.

**Start here:** the full, ordered walkthrough is **[Step-by-step: Salesforce JWT for AgentCore (detailed)](#step-by-step-salesforce-jwt-for-agentcore-detailed)** below. The short list is:

1. Copy [`.env.harness.sample`](../.env.harness.sample) to **`.env.harness`** (repo root or `salesforceAgent00/.env.harness`).
2. Choose **Secrets Manager** (pointers only) or **inline PEM** in `.env.harness` — detailed in that section.
3. From repo root: **`npm run merge-harness-env`** → sync harness build (Path A) → **`agentcore deploy`** from `salesforceAgent00/` → back to repo root: **`npm run push-harness-env`**.
4. Optionally **`npm run merge-harness-env -- --clear`** before `git commit`.

More context: [agentcore-harness/README.md](../agentcore-harness/README.md) and the root README [Path A / Path B](../README.md#4-deploy-an-agentcore-harness-and-set-harness_arn).

## Step-by-step: Salesforce JWT for AgentCore (detailed)

This section assumes the **in-repo** AgentCore layout: [`salesforceAgent00/`](../salesforceAgent00/) with harness at [`app/sfHarness00/`](../salesforceAgent00/app/sfHarness00/). If your project path differs, replace `salesforceAgent00` everywhere.

### 0. Terms (so nothing is ambiguous)

| Term | Meaning |
|------|--------|
| **Repo root** | The `salesforce-agent` git checkout (where the root `package.json` lives). |
| **AgentCore project dir** | `salesforceAgent00/` — contains `agentcore/agentcore.json`. You run **`agentcore deploy`** **here**, not at repo root. |
| **Harness app dir** | `salesforceAgent00/app/sfHarness00/` — contains `harness.json`, `Dockerfile`, `scripts/sf-query.js` after sync. |
| **Bolt `.env`** | Repo root `.env` — Slack tokens, `HARNESS_ARN`, AWS profile for **your laptop** calling `InvokeHarness`. **No Salesforce PEM here** unless you only run `sf-query` locally. |
| **`.env.harness`** | Salesforce / AWS pointers for the harness. Read by **`npm run merge-harness-env`**. Can live at **repo root** or **`salesforceAgent00/.env.harness`**. |

### 1. Prerequisites (Salesforce side)

1. In Salesforce, you have a **Connected App** with **OAuth** enabled and a **certificate** (or you use a **JWT** integration with a **server** private key).
2. You know the **Consumer Key** → this repo calls it **`SF_CLIENT_ID`**.
3. You know the **integration user’s username** (often an email) → **`SF_USERNAME`**.
4. You have the **PKCS#8 private key** matching the Connected App (often `-----BEGIN PRIVATE KEY-----` …). For this repo, prefer extracting **`SF_PRIVATE_KEY_BODY`** (base64 between the PEM lines, one long line) — see [`.env.harness.sample`](../.env.harness.sample).

### 2. Choose how JWT material gets into `sf-query`

**Option A — AWS Secrets Manager (recommended in production)**  
You store **one JSON document** in Secrets Manager. The harness only receives **pointers** (`SF_SECRET_ID`), not the PEM in git. At runtime `sf-query` calls **`GetSecretValue`** using the **harness execution role** and merges the JSON keys into `process.env`.

**Option B — Inline in `.env.harness`**  
You put `SF_CLIENT_ID`, `SF_USERNAME`, and `SF_PRIVATE_KEY_BODY` (or file path / quoted PEM) directly in `.env.harness`. **`merge-harness-env`** copies them into `harness.json` and into **`.harness-salesforce-env.json`**, which is **baked into the Docker image**. This avoids depending on AgentCore injecting env into tool shells.

You can use **both**: e.g. pointers in `harness.json` for `push-harness-env`, and the baked file for reliability — **`merge-harness-env`** writes both when you use inline fields.

---

### 3A. Option A — Secrets Manager (every click / field)

**Step A1 — Build the JSON (once)**  
Create a JSON object (minify or pretty-print, both work) with **string** values only. Example shape:

```json
{
  "SF_LOGIN_URL": "https://login.salesforce.com",
  "SF_CLIENT_ID": "YOUR_CONNECTED_APP_CONSUMER_KEY",
  "SF_USERNAME": "integration.user@yourcompany.com",
  "SF_PRIVATE_KEY_BODY": "MIIE...paste_the_full_base64_body_one_line..."
}
```

- **`SF_PRIVATE_KEY_BODY`**: only the base64 between `BEGIN PRIVATE KEY` and `END PRIVATE KEY`, with **no** PEM headers and **no** line breaks inside the value.
- Use **`https://test.salesforce.com`** for `SF_LOGIN_URL` if the user lives in a sandbox.

**Step A2 — Create the secret in AWS**

1. Open **AWS Console** → **Secrets Manager** (same **Region** as your harness, e.g. `us-west-2`).
2. **Store a new secret** → **Other type of secret** → **Plaintext** tab.
3. Paste the **entire JSON** from Step A1.  
4. Name the secret (e.g. `salesforce-agent/jwt`) and finish the wizard.  
5. Copy the secret **ARN** (looks like `arn:aws:secretsmanager:REGION:ACCOUNT:secret:name-6RandomChars`). You will paste this into `.env.harness` as **`SF_SECRET_ID`**.

**Step A3 — IAM on the harness execution role**

The **managed harness** runs `sf-query` with an **IAM execution role** (created by AgentCore / CDK). That role must be allowed to read your secret:

- Attach an inline or managed policy allowing **`secretsmanager:GetSecretValue`** on **that secret’s ARN** (or a narrow `secret` resource pattern).

Example statement (replace ARN):

```json
{
  "Effect": "Allow",
  "Action": "secretsmanager:GetSecretValue",
  "Resource": "arn:aws:secretsmanager:us-west-2:123456789012:secret:salesforce-agent/jwt-AbCdEf"
}
```

**Step A4 — `.env.harness` (repo root or `salesforceAgent00/`)**

Minimal AWS-only example:

```dotenv
SF_SECRET_ID=arn:aws:secretsmanager:us-west-2:123456789012:secret:salesforce-agent/jwt-AbCdEf
# Optional if AgentCore does not set region on the runtime:
# SF_AWS_REGION=us-west-2
# SF_QUERY_DEBUG=1
```

Do **not** put `SF_CLIENT_ID` / PEM in this file if you want secrets **only** in Secrets Manager.

**Optional — SSM Parameter Store instead of or in addition to Secrets Manager**  
Store the **same JSON** as a **SecureString** parameter. Set **`SF_SSM_PARAMETER_NAME=/your/param/name`**. The execution role needs **`ssm:GetParameter`** on that parameter and **`kms:Decrypt`** on the parameter’s KMS key. If both **`SF_SECRET_ID`** and **`SF_SSM_PARAMETER_NAME`** are set, **`sf-query`** loads the secret first, then SSM (SSM can override keys if **`SF_AWS_CREDS_OVERRIDE=1`**).

---

### 3B. Option B — Inline PEM in `.env.harness`

1. Copy [`.env.harness.sample`](../.env.harness.sample) to **`.env.harness`**.
2. Set **`SF_LOGIN_URL`**, **`SF_CLIENT_ID`**, **`SF_USERNAME`**.
3. Set **one** of: **`SF_PRIVATE_KEY_BODY`** (one line), **`SF_PRIVATE_KEY_FILE=./key.pem`**, or double-quoted multiline **`SF_PRIVATE_KEY`**.  
   **Never** leave a multiline PEM **unquoted** in dotenv — only the first line is read.

---

### 4. Merge, sync, deploy, push (exact order, Path A)

All paths below are from your machine unless `cd` says otherwise.

| Step | Where to run the command | What to type |
|------|---------------------------|--------------|
| 1 | **Repo root** | `./scripts/sync-harness-build-to-agentcore.sh ./salesforceAgent00` |
| 2 | **Repo root** | `npm run merge-harness-env` |
| 3 | **Repo root** | `cd salesforceAgent00` |
| 4 | **`salesforceAgent00/`** | `agentcore deploy` (optional: `agentcore validate` first) |
| 5 | **`salesforceAgent00/`** | `cd ..` (you are back at **repo root**) |
| 6 | **Repo root** | Put **`HARNESS_ARN`** in **`.env`** if this is the first deploy (from deploy output or `agentcore status` run inside `salesforceAgent00/`). |
| 7 | **Repo root** | `npm run push-harness-env` |

What each step does:

- **Sync script** — Copies `agentcore-harness/Dockerfile`, `package.json`, `package-lock.json`, `.harness-salesforce-env.json` stub, and `sf-query.js` into `salesforceAgent00/app/sfHarness00/` so CodeBuild’s `docker build` context is complete.
- **`merge-harness-env`** — Reads `.env.harness`, updates **`app/sfHarness00/harness.json` → `environmentVariables`**, and writes **`app/sfHarness00/.harness-salesforce-env.json`** (JWT snapshot for the image). If you use **Secrets Manager only**, `harness.json` will contain **`SF_SECRET_ID`** (and optional SSM name), not the PEM.
- **`agentcore deploy`** — Builds and publishes the **container image** and updates harness infrastructure from **`salesforceAgent00/`**.
- **`push-harness-env`** — Calls AWS **`UpdateHarness`** so the **control plane** `environmentVariables` match your local `harness.json` (some deploy paths skip this).

After **any** change to `.env.harness` or Salesforce secrets: repeat **merge → (sync if Dockerfile/deps changed) → deploy → push**.

### 5. Run Bolt and test Slack

1. **Repo root**: `npm start`.
2. In Slack, DM the app or use the assistant thread.
3. If it still behaves like an old session after credential changes: set **`HARNESS_RUNTIME_SESSION_SALT`** to a new value in **`.env`**, restart `npm start`, or start a **new** Slack thread (see [Runtime session id rules](#runtime-session-id-rules)).

### 6. Before `git commit` (strip local secrets)

From **repo root**:

```bash
npm run merge-harness-env -- --clear
```

That removes Salesforce secrets (and AWS pointer keys) from **`harness.json`** and resets **`.harness-salesforce-env.json`** to `{}`. Re-run **merge (without `--clear`)** before the next deploy.

### 7. How `sf-query` resolves credentials (order)

1. **`/app/.harness-salesforce-env.json`** or the copy next to `scripts/sf-query.js` (baked at image build).
2. If **`SF_SECRET_ID`** / **`SF_SSM_PARAMETER_NAME`** are set → fetch JSON from AWS and merge **`SF_*`** into `process.env`.
3. Existing **`process.env`** from the platform (when AgentCore injects harness env into the process).

Region for AWS SDK: **`AWS_REGION`** or **`AWS_DEFAULT_REGION`** or **`SF_AWS_REGION`**.

### 8. Local verification (your laptop)

From **repo root**:

```bash
npm run debug-sf-query -- "SELECT Id FROM User LIMIT 1"
```

Uses **`harness.json` → `environmentVariables`** and **`SF_QUERY_DEBUG=1`**. Stderr shows `[sf-query]` stages; stdout shows SOQL JSON. If this fails, fix Salesforce JWT or AWS pointers before debugging Slack again.

### 9. Troubleshooting

| Symptom | What to check |
|---------|----------------|
| **`SF_AWS_FETCH_ERROR`** or AccessDenied in CloudWatch | Harness **execution role** missing `GetSecretValue` / `GetParameter` / `kms:Decrypt`; wrong region; wrong secret ARN. |
| **`SF_AWS_REGION_MISSING`** | Set **`AWS_REGION`** on the harness or **`SF_AWS_REGION`** in `harness.json` via merge. |
| Slack still “missing credentials” but **`debug-sf-query` works** | Stale **runtime session** → bump **`HARNESS_RUNTIME_SESSION_SALT`**, new Slack thread, or wait for session expiry; confirm **`HARNESS_ARN`** matches the harness you deployed. |
| **`GetHarness`** from **`push-harness-env`** shows zero length for `SF_*` | Wrong harness / wrong account; re-run **push**; confirm **merge** ran. |

### Debug `sf-query.js`

1. **Same env as the harness, on your laptop** — from repo root: **`npm run debug-sf-query`** (optional SOQL after `--`, in quotes if it contains spaces). This loads **`salesforceAgent00/.../harness.json` → `environmentVariables`**, sets **`SF_QUERY_DEBUG=1`**, and runs **`scripts/sf-query.js`**. You see **`[sf-query]`** JSON lines on **stderr** and the normal SOQL JSON on **stdout** — same terminal.

2. **Inside the deployed harness** — add **`SF_QUERY_DEBUG=1`** to **`.env.harness`**, run **`npm run merge-harness-env`**, **`npm run push-harness-env`**, and redeploy the image if `sf-query.js` changed. Tool stderr is **not** shown in the Bolt terminal; open **CloudWatch** (or your AgentCore / runtime log sink) for the harness **session / tool execution** logs and filter for **`[sf-query]`**.

### Why `GetHarness` can show env but Slack still fails

AgentCore sometimes does **not** pass harness **`environmentVariables`** into **tool/shell** processes. That is why the detailed guide above uses **Secrets Manager / SSM** and/or the **baked `.harness-salesforce-env.json`** and documents the **resolution order** in **[section 7](#7-how-sf-query-resolves-credentials-order)**.

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

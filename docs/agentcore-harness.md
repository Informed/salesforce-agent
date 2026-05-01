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

## Environment variables (Slack app process)

| Variable | Purpose |
|----------|---------|
| `HARNESS_ARN` | ARN of the deployed harness (`arn:aws:bedrock-agentcore:region:account:harness/...`). |
| `AWS_REGION` | Optional if the region can be parsed from `HARNESS_ARN`; otherwise set explicitly. |
| Slack + Salesforce | See [`.env.sample`](../.env.sample). |

The Slack host only needs credentials to call **AWS** (profile, env keys, or ECS/Lambda task role). Salesforce credentials are **not** read by the Slack process for harness calls; they must be available **inside the harness** (see below).

## IAM for the Slack app caller

The principal that runs Bolt (human laptop, ECS task role, etc.) must be allowed to invoke the harness. AWS documents that **`InvokeHarness` requires both**:

- `bedrock-agentcore:InvokeHarness`
- `bedrock-agentcore:InvokeAgentRuntime`

on the harness resource. See [Security and access controls](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-security.html).

Start from managed policies only in sandboxes; use least-privilege policies in production.

## Harness execution role and Salesforce

The managed harness runs in an isolated environment. To run `node scripts/sf-query.js` as documented in [`.cursor/rules/salesforce-agent.md`](../.cursor/rules/salesforce-agent.md), you typically:

1. **Custom container (recommended for parity)** — This repo includes [`agentcore-harness/Dockerfile`](../agentcore-harness/Dockerfile) (linux/arm64, Node 22, `scripts/sf-query.js` + prod dependencies). When `agentcore create` asks for the Dockerfile path, from the **salesforce-agent** repo root enter **`agentcore-harness/Dockerfile`** (or an absolute path to that file). Set `SF_*` on the harness, not in the image. See [Environment and Skills](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-environment.html) and [agentcore-harness/README.md](../agentcore-harness/README.md).

2. **AgentCore Gateway / MCP** — Expose SOQL or data access as tools and attach them to the harness; tighter coupling to AWS, less “run arbitrary shell” surface.

The **system instructions** sent from the Slack app are duplicated in [`agent/system-instructions.js`](../agent/system-instructions.js); keep them aligned with `.cursor/rules` when you change behavior.

## Runtime session id rules

`X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` must match `[a-zA-Z0-9][a-zA-Z0-9-_]*` and length constraints (see API). Slack `thread_ts` contains `.`, so this app uses `deriveRuntimeSessionId()` — a **`s` + SHA-256 hex** string (65 characters). Legacy Cursor agent ids in the in-memory store are ignored when invalid, and the derived id is written back after a successful reply.

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

- **Update harness config / model / tools**: change the AgentCore project files created by the CLI, then `agentcore deploy` again.
- **Update only the Slack app**: deploy your Node process as usual (new container image, PM2 restart, etc.); code changes to `agent/*.js` do not require harness redeploy unless you change contract (e.g. payload shape).
- **Secrets**: prefer AWS Secrets Manager or SSM Parameter Store, referenced from harness environment or execution role; avoid committing secrets.

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

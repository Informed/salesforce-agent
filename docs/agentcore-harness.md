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

Preview CLI (from AWS docs):

```bash
npm install -g @aws/agentcore@preview
agentcore create --name mysalesforceagent --model-provider bedrock
# In the wizard, choose Harness as the project type and configure model, memory, tools, and environment.
agentcore deploy
```

After deploy, copy the harness **ARN** into `HARNESS_ARN` for the Slack app.

Local iteration:

```bash
agentcore dev
```

Use the agent inspector to validate prompts and tools before wiring Slack.

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

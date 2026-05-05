# Harness custom image

This folder is a **standalone Docker build context** for the AgentCore harness (Node + `sf-query.js` + minimal npm deps).

**End-to-end setup (Slack app + first deploy):** see the repository [README.md](../README.md). **Harness-only details, IAM, and troubleshooting:** [docs/agentcore-harness.md](../docs/agentcore-harness.md).

## Why `agentcore deploy` failed with “package-lock.json / scripts/sf-query.js not found”

CodeBuild runs something equivalent to:

```bash
docker build -f Dockerfile .
```

The build **context (`.`)** is the harness folder from **`agentcore/agentcore.json` → `harnesses[0].path`** (for example `app/sfHarness00`), **not** the AgentCore project root and not the `salesforce-agent` repo. `COPY package.json` and `COPY scripts/...` must exist **under that path**. The sync script reads `agentcore.json` and copies files into the correct directory.

## Before every `agentcore deploy`

From the **salesforce-agent** repo:

```bash
./scripts/sync-harness-build-to-agentcore.sh /path/to/your-agentcore-project
```

Example:

```bash
./scripts/sync-harness-build-to-agentcore.sh ~/work/mysalesforceagent
cd ~/work/mysalesforceagent
agentcore deploy
```

In `agentcore create`, for the Dockerfile use **`./Dockerfile`** inside that same project directory (after sync), not only a path back into this repo.

## Interactive wizard reminder

Run `agentcore create` **with no flags** (or plain `agentcore`) so the CLI asks for Harness, Dockerfile, etc. Passing `--name` skips prompts.

## Keep `sf-query.js` in sync

Canonical script: [`../scripts/sf-query.js`](../scripts/sf-query.js). After editing it:

```bash
npm run sync:agentcore-harness
```

Then re-run the sync script to your AgentCore project before the next image build.

## Local Docker check (optional)

From **this** directory (where `Dockerfile`, `package.json`, and `scripts/` exist):

```bash
docker build -f Dockerfile -t salesforce-harness:local .
```

Use `--platform linux/arm64` locally only if your machine defaults to a different architecture and you want to match AgentCore.

Configure `SF_*` on the harness at runtime, not in the image.

**Docker Hub rate limits:** the Dockerfile uses `public.ecr.aws/docker/library/node` so CodeBuild is not subject to anonymous [Docker Hub pull limits](https://www.docker.com/increase-rate-limit). If you switch back to `docker.io/library/node`, expect occasional `429` failures on shared CI IPs.

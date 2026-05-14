# Amazon Bedrock AgentCore Harness — custom environment (image platform set by AgentCore/CodeBuild).
#
# IMPORTANT: `agentcore deploy` zips the harness directory from agentcore.json → harnesses[0].path
# (e.g. app/sfHarness00) and runs `docker build -f Dockerfile .` there — not the monorepo root.
# Before deploy, from salesforce-agent repo run:
#   ./scripts/sync-harness-build-to-agentcore.sh /path/to/your-agentcore-project

# syntax=docker/dockerfile:1
# Pull from AWS Public ECR (Docker Hub mirror). CodeBuild often hits Docker Hub anonymous
# rate limits (429) on registry-1.docker.io — see https://www.docker.com/increase-rate-limit
FROM public.ecr.aws/docker/library/node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
# Prefer install over ci: CodeBuild’s Node/npm version can disagree with the lockfile from your laptop.
RUN npm install --omit=dev --no-audit --no-fund

# JWT for sf-query — `npm run merge-harness-env` overwrites this in app/sfHarness00 before deploy; stub `{}` in git.
COPY .harness-salesforce-env.json /app/.harness-salesforce-env.json
# Same SF_* as control plane `environmentVariables` (tracked in app/sfHarness00); sf-query falls back if the dotfile is missing in the tool sandbox.
COPY harness.json /app/harness.json
COPY scripts/sf-query.js ./scripts/

# Harness manages the main process; keep a harmless default for local `docker run`.
CMD ["tail", "-f", "/dev/null"]

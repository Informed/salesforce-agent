# Amazon Bedrock AgentCore Harness — custom environment (linux/arm64).
#
# IMPORTANT: `agentcore deploy` uploads only your AgentCore project folder to CodeBuild and runs
#   docker build -f Dockerfile .
# so the build CONTEXT is that folder — not the salesforce-agent repo. Before deploy, run:
#   ./scripts/sync-harness-build-to-agentcore.sh /path/to/your-agentcore-project
# then set the wizard Dockerfile path to ./Dockerfile inside that project (see agentcore-harness/README.md).

# syntax=docker/dockerfile:1
# Pull from AWS Public ECR (Docker Hub mirror). CodeBuild often hits Docker Hub anonymous
# rate limits (429) on registry-1.docker.io — see https://www.docker.com/increase-rate-limit
FROM public.ecr.aws/docker/library/node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
# Prefer install over ci: CodeBuild’s Node/npm version can disagree with the lockfile from your laptop.
RUN npm install --omit=dev --no-audit --no-fund

COPY scripts/sf-query.js ./scripts/

# Harness manages the main process; keep a harmless default for local `docker run`.
CMD ["tail", "-f", "/dev/null"]

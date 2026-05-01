# Amazon Bedrock AgentCore Harness — custom environment (linux/arm64).
# Point `agentcore create` at this file, e.g. ./agentcore-harness/Dockerfile
# from the salesforce-agent repo root (or use an absolute path).

# syntax=docker/dockerfile:1
FROM --platform=linux/arm64 node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY scripts/sf-query.js ./scripts/

# Harness manages the main process; keep a harmless default for local `docker run`.
CMD ["tail", "-f", "/dev/null"]

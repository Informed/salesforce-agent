#!/usr/bin/env bash
# Copy harness Docker build context into the AgentCore CLI project directory.
# AgentCore CodeBuild runs: docker build -f Dockerfile .  with context = that project root only
# (not the salesforce-agent repo), so these files must live there before deploy.
set -euo pipefail
DEST="${1:?Usage: $0 /path/to/your-agentcore-project (e.g. ~/mysalesforceagent)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for f in Dockerfile package.json package-lock.json; do
  cp "${ROOT}/agentcore-harness/${f}" "${DEST}/"
done
mkdir -p "${DEST}/scripts"
cp "${ROOT}/agentcore-harness/scripts/sf-query.js" "${DEST}/scripts/"
echo "Synced harness build files into ${DEST}. From that directory run: agentcore deploy"

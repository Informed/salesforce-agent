#!/usr/bin/env bash
# Copy harness Docker build context into the AgentCore CLI project.
# CodeBuild runs: docker build -f Dockerfile .  with context = the harness directory
# listed in agentcore/agentcore.json → harnesses[0].path (e.g. app/sfHarness00),
# NOT the monorepo root. Files must exist under that path before deploy.
set -euo pipefail
DEST="${1:?Usage: $0 /path/to/your-agentcore-project (e.g. ./salesforceAgent00)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SPEC="${DEST}/agentcore/agentcore.json"
if [[ ! -f "$SPEC" ]]; then
  echo "error: missing $SPEC — pass the AgentCore project root (contains agentcore/)." >&2
  exit 1
fi
REL="$(node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const h = p.harnesses && p.harnesses[0];
if (!h || !h.path) process.exit(2);
console.log(h.path);
" "$SPEC")" || {
  echo "error: could not read harnesses[0].path from $SPEC" >&2
  exit 1
}
TARGET="${DEST}/${REL}"
mkdir -p "${TARGET}/scripts"
for f in Dockerfile package.json package-lock.json; do
  cp "${ROOT}/agentcore-harness/${f}" "${TARGET}/"
done
cp "${ROOT}/agentcore-harness/scripts/sf-query.js" "${TARGET}/scripts/"
echo "Synced harness build files into ${TARGET} (harness path: ${REL}). From ${DEST} run: agentcore deploy"

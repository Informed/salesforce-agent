# Harness custom image

This Dockerfile is for **AgentCore managed harness** when you choose a custom environment.

- **Path to enter in the wizard:** from the parent repo directory, use  
  `agentcore-harness/Dockerfile`  
  or an absolute path such as  
  `/full/path/to/salesforce-agent/agentcore-harness/Dockerfile`.

- **Platform:** `linux/arm64` (required for AgentCore Runtime / harness).

- **Contents:** Node.js plus `scripts/sf-query.js` and production npm dependencies from the root `package.json`.

Configure `SF_*` variables on the harness (secrets / env), not in the image. For multiline keys in env vars, use `SF_PRIVATE_KEY_BODY` (see `scripts/sf-query.js`).

Build locally to verify:

```bash
cd "$(git rev-parse --show-toplevel)"
docker build --platform linux/arm64 -f agentcore-harness/Dockerfile -t salesforce-harness:local .
```

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Human-facing setup, updates, and runbooks:** [README.md](../README.md) and [docs/agentcore-harness.md](../docs/agentcore-harness.md).

## AgentCore Harness

**Agent (`agent/agent.js`)** calls `invokeHarnessCollectText()` in `agent/harness-client.js`, which uses `@aws-sdk/client-bedrock-agentcore` (`InvokeHarnessCommand`). `runAgent()` is async and returns `{ responseText, agentId }` where `agentId` is the harness **runtime session id** for that Slack thread.

**System prompt** content lives in `agent/system-instructions.js` and should stay aligned with `.cursor/rules/salesforce-agent.md`.

**Slack-only behavior** (e.g. emoji reactions) uses `deps` from listeners; the harness runs in AWS.

**Session continuity**: `thread-context/store.js` maps `channelId:threadTs` to the runtime session id. `agent/runtime-session-id.js` derives a valid id when the stored value is missing or invalid (e.g. legacy Cursor ids).

**Feedback blocks** use the `context_actions` block type with `feedback_buttons` elements. A single `feedback` action ID is registered.

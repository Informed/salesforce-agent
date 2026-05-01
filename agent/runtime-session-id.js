import { createHash } from 'node:crypto';

/** Max length for X-Amzn-Bedrock-AgentCore-Runtime-Session-Id (per AWS docs). */
export const RUNTIME_SESSION_ID_MAX_LEN = 100;

/** Pattern: first char alphanumeric, rest alphanumeric, hyphen, underscore. */
const RUNTIME_SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/**
 * @param {string | undefined | null} id
 * @returns {boolean}
 */
export function isValidRuntimeSessionId(id) {
  if (id == null || id.length < 1 || id.length > RUNTIME_SESSION_ID_MAX_LEN) return false;
  return RUNTIME_SESSION_ID_PATTERN.test(id);
}

/**
 * Stable harness runtime session id for a Slack channel + thread.
 * Uses hex digest so only [0-9a-f] (always valid for the harness pattern).
 * @param {string} channelId
 * @param {string} threadTs
 * @returns {string}
 */
export function deriveRuntimeSessionId(channelId, threadTs) {
  const raw = `${channelId}:${threadTs}`;
  const hex = createHash('sha256').update(raw, 'utf8').digest('hex');
  return `s${hex}`;
}

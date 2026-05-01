import { HarnessConversationRole } from '@aws-sdk/client-bedrock-agentcore';

import { invokeHarnessCollectText } from './harness-client.js';
import { deriveRuntimeSessionId, isValidRuntimeSessionId } from './runtime-session-id.js';
import { HARNESS_SALESFORCE_RULES } from './system-instructions.js';

const HARNESS_ARN = process.env.HARNESS_ARN;

/**
 * @typedef {Object} AgentDeps
 * @property {import('@slack/web-api').WebClient} client
 * @property {string} userId
 * @property {string} channelId
 * @property {string} threadTs
 * @property {string} messageTs
 * @property {string} [userToken]
 */

/**
 * Add an emoji reaction to the user's message.
 * Picks a contextual emoji based on simple keyword matching.
 * @param {AgentDeps} deps
 */
async function addReaction(deps) {
  const emojis = ['eyes', 'mag', 'chart_with_upwards_trend', 'salesforce', 'thinking_face', 'zap', 'rocket'];
  const emoji = emojis[Math.floor(Math.random() * emojis.length)];
  try {
    await deps.client.reactions.add({
      channel: deps.channelId,
      timestamp: deps.messageTs,
      name: emoji,
    });
  } catch {
    // Reaction failed (e.g. already_reacted) — not critical
  }
}

const SLACK_DIRECTIVE = [
  'You are responding DIRECTLY to a Slack user. Your response text will be posted',
  'as a Slack message automatically — do NOT wrap it in a draft, do NOT say',
  '"here\'s a Slack-ready reply", do NOT address yourself in third person.',
  'Just respond naturally and concisely as if you are chatting with the user.',
  '',
  HARNESS_SALESFORCE_RULES,
].join('\n');

/**
 * Resolve harness runtime session id (Slack thread continuity).
 * @param {string | undefined} storedSessionId
 * @param {AgentDeps | undefined} deps
 * @returns {string}
 */
function resolveRuntimeSessionId(storedSessionId, deps) {
  if (storedSessionId && isValidRuntimeSessionId(storedSessionId)) {
    return storedSessionId;
  }
  if (deps?.channelId && deps?.threadTs) {
    return deriveRuntimeSessionId(deps.channelId, deps.threadTs);
  }
  throw new Error('Harness session requires channelId and threadTs in deps, or a valid stored runtime session id');
}

/**
 * Run the agent with the given text and optional stored runtime session id for follow-up.
 * @param {string} text - The user's message text.
 * @param {string} [storedSessionId] - Previously stored harness runtime session id (must satisfy harness id pattern).
 * @param {AgentDeps} [deps] - Dependencies for Slack API access.
 * @returns {Promise<{responseText: string, agentId: string | null}>}
 */
export async function runAgent(text, storedSessionId = undefined, deps = undefined) {
  if (!HARNESS_ARN) {
    throw new Error('HARNESS_ARN is not set. Deploy a harness and set its ARN.');
  }

  if (deps) {
    addReaction(deps);
  }

  const runtimeSessionId = resolveRuntimeSessionId(storedSessionId, deps);

  const systemPrompt = [{ text: SLACK_DIRECTIVE }];
  const messages = [
    {
      role: HarnessConversationRole.USER,
      content: [{ text: `User <@${deps?.userId || 'unknown'}> says: ${text}` }],
    },
  ];

  const responseText = await invokeHarnessCollectText({
    harnessArn: HARNESS_ARN,
    runtimeSessionId,
    messages,
    systemPrompt,
  });

  return {
    responseText: responseText || '_The agent completed but produced no text output._',
    agentId: runtimeSessionId,
  };
}

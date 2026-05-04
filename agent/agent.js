import axios from 'axios';
import { createAgent, createFollowUpRun, streamRunResponse } from './cursor-client.js';

const CURSOR_API_KEY = process.env.CURSOR_API_KEY;
const CURSOR_REPO_URL = process.env.CURSOR_REPO_URL;
const CURSOR_REPO_BRANCH = process.env.CURSOR_REPO_BRANCH || 'main';
const CURSOR_MODEL = process.env.CURSOR_MODEL || 'composer-2';

const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

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
 * @typedef {Object} PromptImage
 * @property {string} data - base64-encoded image bytes
 * @property {{width: number, height: number}} dimension
 */

/**
 * Download image files attached to a Slack message and return them as
 * base64-encoded objects ready for the Cursor Cloud Agent API.
 * @param {Array<Record<string, any>>} files - Slack file objects from event.files
 * @param {string} botToken
 * @returns {Promise<PromptImage[]>}
 */
export async function extractSlackImages(files, botToken) {
  const imageFiles = files
    .filter((f) => f.mimetype?.startsWith('image/') && (f.size ?? 0) <= MAX_IMAGE_BYTES)
    .slice(0, MAX_IMAGES);

  /** @type {PromptImage[]} */
  const images = [];

  for (const file of imageFiles) {
    const url = file.url_private_download || file.url_private;
    if (!url) continue;
    try {
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${botToken}` },
        responseType: 'arraybuffer',
      });
      images.push({
        data: Buffer.from(res.data).toString('base64'),
        dimension: {
          width: file.original_w ?? 0,
          height: file.original_h ?? 0,
        },
      });
    } catch {
      // Skip files that fail to download
    }
  }

  return images;
}

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

/**
 * Build the prompt sent to the Cursor Cloud Agent, including context
 * about the Slack user and conversation.
 * @param {string} text - The user's message.
 * @param {string} userId
 * @param {boolean} [hasImages=false]
 * @returns {string}
 */
function buildPrompt(text, userId, hasImages = false) {
  const lines = [
    'You are responding DIRECTLY to a Slack user. Your response text will be posted',
    'as a Slack message automatically — do NOT wrap it in a draft, do NOT say',
    '"here\'s a Slack-ready reply", do NOT address yourself in third person.',
    'Just respond naturally and concisely as if you are chatting with the user.',
    '',
    'Follow the instructions in .cursor/rules/salesforce-agent.md.',
    'If the user asks about Salesforce data,',
    'run `node scripts/sf-query.js "<SOQL>"` to fetch live data and summarize it.',
    '',
  ];
  if (hasImages) {
    lines.push('The user has attached image(s) to their message. Examine them carefully and incorporate what you see into your response.');
    lines.push('');
  }
  lines.push(`User <@${userId}> says: ${text}`);
  return lines.join('\n');
}

/**
 * Run the agent with the given text and optional agent ID for follow-up.
 * @param {string} text - The user's message text.
 * @param {string} [agentId] - An existing agent ID to send a follow-up run.
 * @param {AgentDeps} [deps] - Dependencies for Slack API access.
 * @param {PromptImage[]} [images] - Base64-encoded images to attach to the prompt.
 * @returns {Promise<{responseText: string, agentId: string | null}>}
 */
export async function runAgent(text, agentId = undefined, deps = undefined, images = undefined) {
  const t0 = Date.now();
  console.log(`[agent] runAgent: start (existingAgent=${!!agentId}, images=${images?.length ?? 0}, model=${CURSOR_MODEL})`);

  if (!CURSOR_API_KEY) {
    throw new Error('CURSOR_API_KEY is not set. Get one from cursor.com/dashboard/integrations');
  }
  if (!CURSOR_REPO_URL) {
    throw new Error('CURSOR_REPO_URL is not set. Set it to your GitHub repo URL.');
  }

  if (deps) {
    addReaction(deps);
  }

  const hasImages = images && images.length > 0;
  const prompt = buildPrompt(text, deps?.userId || 'unknown', hasImages);

  let newAgentId;
  let runId;

  if (agentId) {
    try {
      const result = await createFollowUpRun({
        apiKey: CURSOR_API_KEY,
        agentId,
        prompt,
        images,
      });
      newAgentId = agentId;
      runId = result.runId;
    } catch {
      console.log(`[agent] runAgent: follow-up failed, creating new agent`);
      const result = await createAgent({
        apiKey: CURSOR_API_KEY,
        prompt,
        images,
        repoUrl: CURSOR_REPO_URL,
        branch: CURSOR_REPO_BRANCH,
        model: CURSOR_MODEL,
      });
      newAgentId = result.agentId;
      runId = result.runId;
    }
  } else {
    const result = await createAgent({
      apiKey: CURSOR_API_KEY,
      prompt,
      images,
      repoUrl: CURSOR_REPO_URL,
      branch: CURSOR_REPO_BRANCH,
      model: CURSOR_MODEL,
    });
    newAgentId = result.agentId;
    runId = result.runId;
  }

  console.log(`[agent] runAgent: agent ready at +${Date.now() - t0}ms, streaming response...`);

  const responseText = await streamRunResponse({
    apiKey: CURSOR_API_KEY,
    agentId: newAgentId,
    runId,
  });

  console.log(`[agent] runAgent: total time ${Date.now() - t0}ms`);
  return { responseText: responseText || '_The agent completed but produced no text output._', agentId: newAgentId };
}

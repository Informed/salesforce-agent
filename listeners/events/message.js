import { runAgent, extractSlackImages } from '../../agent/index.js';
import { sessionStore } from '../../thread-context/index.js';
import { buildFeedbackBlocks } from '../views/feedback-builder.js';

/**
 * @param {import('@slack/types').MessageEvent} event
 * @returns {event is import('@slack/types').GenericMessageEvent}
 */
function isGenericMessageEvent(event) {
  return !('subtype' in event && event.subtype !== undefined);
}

/**
 * Handle messages sent to the agent via DM or in threads the bot is part of.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'message'>} args
 * @returns {Promise<void>}
 */
export async function handleMessage({ client, context, event, logger, say, sayStream, setStatus }) {
  // Skip message subtypes (edits, deletes, etc.)
  if (!isGenericMessageEvent(event)) return;

  // Skip bot messages
  if (event.bot_id) return;

  const isDm = event.channel_type === 'im';
  const isThreadReply = !!event.thread_ts;

  if (isDm) {
    // DMs are always handled
  } else if (isThreadReply) {
    // Channel thread replies are handled only if the bot is already engaged
    const session = sessionStore.getSession(event.channel, /** @type {string} */ (event.thread_ts));
    if (session === null) return;
  } else {
    // Top-level channel messages are handled by app_mentioned
    return;
  }

  try {
    const channelId = event.channel;
    const text = event.text || '';
    const threadTs = event.thread_ts || event.ts;
    const userId = /** @type {string} */ (context.userId);

    // Get session ID for conversation context
    const existingSessionId = sessionStore.getSession(channelId, threadTs);

    // Set assistant thread status with loading messages
    await setStatus({
      status: 'Thinking\u2026',
      loading_messages: [
        'Teaching the hamsters to type faster\u2026',
        'Untangling the internet cables\u2026',
        'Consulting the office goldfish\u2026',
        'Polishing up the response just for you\u2026',
        'Convincing the AI to stop overthinking\u2026',
      ],
    });

    // Post an immediate acknowledgment so the user knows we're working
    const ack = await say({ text: '_Got your request — working on it…_', thread_ts: threadTs });

    // Download any attached images for the agent
    const images = event.files?.length
      ? await extractSlackImages(event.files, /** @type {string} */ (context.botToken))
      : undefined;

    if (images?.length) {
      await client.chat.update({
        channel: channelId,
        ts: /** @type {string} */ (ack.ts),
        text: `_Got your request — downloaded ${images.length} image(s), sending to agent…_`,
      });
    }

    // Run the agent with deps for tool access
    const deps = { client, userId, channelId, threadTs, messageTs: event.ts, userToken: context.userToken };
    const { responseText, agentId: newAgentId } = await runAgent(text, existingSessionId ?? undefined, deps, images);

    // Replace the progress message with the actual response + feedback buttons
    const feedbackBlocks = buildFeedbackBlocks();
    await client.chat.update({
      channel: channelId,
      ts: /** @type {string} */ (ack.ts),
      text: responseText,
      blocks: feedbackBlocks,
    });

    // Store agent ID for conversation continuity
    if (newAgentId) {
      sessionStore.setSession(channelId, threadTs, newAgentId);
    }
  } catch (e) {
    logger.error(`Failed to handle message: ${e}`);
    await say({
      text: `:warning: Something went wrong! (${e})`,
      thread_ts: event.thread_ts || event.ts,
    });
  }
}

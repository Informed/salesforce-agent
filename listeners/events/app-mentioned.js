import { runAgent, extractSlackImages } from '../../agent/index.js';
import { sessionStore } from '../../thread-context/index.js';
import { buildFeedbackBlocks } from '../views/feedback-builder.js';

/**
 * Handle app_mention events and run the agent.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'app_mention'>} args
 * @returns {Promise<void>}
 */
export async function handleAppMentioned({ client, context, event, logger, say, sayStream, setStatus }) {
  try {
    const channelId = event.channel;
    const text = event.text || '';
    const threadTs = event.thread_ts || event.ts;
    const userId = /** @type {string} */ (context.userId);

    // Strip the bot mention from the text
    const cleanedText = text.replace(/<@[A-Z0-9]+>/g, '').trim();

    // Download any attached images for the agent
    const images = event.files?.length
      ? await extractSlackImages(event.files, /** @type {string} */ (context.botToken))
      : undefined;

    if (!cleanedText && !images?.length) {
      await say({
        text: "Hey there! How can I help you? Ask me anything and I'll do my best.",
        thread_ts: threadTs,
      });
      return;
    }

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

    if (images?.length) {
      await client.chat.update({
        channel: channelId,
        ts: /** @type {string} */ (ack.ts),
        text: `_Got your request — downloaded ${images.length} image(s), sending to agent…_`,
      });
    }

    // Get session ID for conversation context
    const existingSessionId = sessionStore.getSession(channelId, threadTs);

    // Run the agent with deps for tool access
    const deps = { client, userId, channelId, threadTs, messageTs: event.ts, userToken: context.userToken };
    const { responseText, agentId: newAgentId } = await runAgent(cleanedText, existingSessionId ?? undefined, deps, images);

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
    logger.error(`Failed to handle app mention: ${e}`);
    await say({
      text: `:warning: Something went wrong! (${e})`,
      thread_ts: event.thread_ts || event.ts,
    });
  }
}

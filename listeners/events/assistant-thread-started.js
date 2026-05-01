const SUGGESTED_PROMPTS = [
  { title: 'Top Opportunities by ARR', message: 'List my top 5 Salesforce opportunities in terms of ARR' },
  { title: 'Closing This Quarter', message: 'Which opportunities are closing this quarter?' },
  { title: 'Pipeline Summary', message: 'Give me a summary of our open pipeline by stage' },
  { title: 'Recently Closed Won', message: 'Show me deals we closed won in the last 30 days' },
];

/**
 * Handle assistant_thread_started events by setting suggested prompts.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'assistant_thread_started'>} args
 * @returns {Promise<void>}
 */
export async function handleAssistantThreadStarted({ client, event, logger }) {
  const { channel_id: channelId, thread_ts: threadTs } = event.assistant_thread;

  try {
    await client.assistant.threads.setSuggestedPrompts({
      channel_id: channelId,
      thread_ts: threadTs,
      title: 'Ask me anything about your Salesforce data',
      prompts: SUGGESTED_PROMPTS,
    });
  } catch (e) {
    logger.error(`Failed to handle assistant thread started: ${e}`);
  }
}

import { BedrockAgentCoreClient, InvokeHarnessCommand } from '@aws-sdk/client-bedrock-agentcore';

import { isSalesforceAgentDebug, salesforceAgentDebug, shortHarnessArn } from './debug.js';

/**
 * @param {string} harnessArn
 * @returns {string | undefined}
 */
function regionFromHarnessArn(harnessArn) {
  const m = /^arn:aws:bedrock-agentcore:([a-z0-9-]+):/i.exec(harnessArn);
  return m?.[1];
}

/** @param {unknown} event @param {string[]} parts */
function appendTextDelta(event, parts) {
  const e = /** @type {{ contentBlockDelta?: { delta?: { text?: string } } }} */ (event);
  const delta = e.contentBlockDelta?.delta;
  if (delta && 'text' in delta && typeof delta.text === 'string' && delta.text.length > 0) {
    parts.push(delta.text);
  }
}

/** @param {unknown} event */
function throwIfHarnessError(event) {
  const e = /** @type {{
    validationException?: { message?: string };
    internalServerException?: { message?: string };
    runtimeClientError?: { message?: string };
  }} */ (event);
  if (e.validationException) {
    const msg = e.validationException.message || 'ValidationException';
    throw new Error(`Harness validation: ${msg}`);
  }
  if (e.internalServerException) {
    const msg = e.internalServerException.message || 'InternalServerException';
    throw new Error(`Harness internal error: ${msg}`);
  }
  if (e.runtimeClientError) {
    const msg = e.runtimeClientError.message || 'RuntimeClientError';
    throw new Error(`Harness runtime client error: ${msg}`);
  }
}

/**
 * Invoke AgentCore managed harness and collect assistant text from the event stream.
 * @param {{
 *   harnessArn: string;
 *   runtimeSessionId: string;
 *   messages: import('@aws-sdk/client-bedrock-agentcore').HarnessMessage[];
 *   systemPrompt?: import('@aws-sdk/client-bedrock-agentcore').HarnessSystemContentBlock[];
 *   timeoutMs?: number;
 * }} opts
 */
export async function invokeHarnessCollectText({
  harnessArn,
  runtimeSessionId,
  messages,
  systemPrompt,
  timeoutMs = 180_000,
}) {
  const region = process.env.AWS_REGION || regionFromHarnessArn(harnessArn);
  if (!region) {
    throw new Error('Could not determine AWS region: set AWS_REGION or use a full harness ARN');
  }

  const client = new BedrockAgentCoreClient({ region });

  /** @type {import('@aws-sdk/client-bedrock-agentcore').InvokeHarnessCommandInput} */
  const input = {
    harnessArn,
    runtimeSessionId,
    messages,
    ...(systemPrompt?.length ? { systemPrompt } : {}),
  };

  if (isSalesforceAgentDebug()) {
    salesforceAgentDebug('InvokeHarness sending', {
      region,
      harness: shortHarnessArn(harnessArn),
      runtimeSessionId,
      timeoutMs,
    });
  }

  const t0 = Date.now();
  const response = await client.send(new InvokeHarnessCommand(input));
  const stream = response.stream;
  if (!stream) {
    throw new Error('Harness invoke returned no stream');
  }

  /** @type {string[]} */
  const parts = [];
  const start = Date.now();
  let streamEvents = 0;

  for await (const event of stream) {
    streamEvents += 1;
    if (Date.now() - start > timeoutMs) {
      throw new Error('Harness invocation timed out');
    }
    throwIfHarnessError(event);
    appendTextDelta(event, parts);
  }

  const text = parts.join('');
  if (isSalesforceAgentDebug()) {
    salesforceAgentDebug('InvokeHarness stream finished', {
      ms: Date.now() - t0,
      streamEvents,
      collectedChars: text.length,
    });
  }

  return text;
}

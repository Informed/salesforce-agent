import { createParser } from 'eventsource-parser';

const CURSOR_API_BASE = 'https://api.cursor.com';

/**
 * @param {string} apiKey
 * @returns {string}
 */
function basicAuth(apiKey) {
  return `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
}

/**
 * @typedef {Object} PromptImage
 * @property {string} data - base64-encoded image bytes
 * @property {{width: number, height: number}} dimension
 */

/**
 * Create a new Cursor Cloud Agent and start an initial run.
 * @param {Object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.prompt
 * @param {PromptImage[]} [opts.images]
 * @param {string} opts.repoUrl
 * @param {string} [opts.branch='main']
 * @param {string} [opts.model='composer-2']
 * @returns {Promise<{agentId: string, runId: string}>}
 */
export async function createAgent({ apiKey, prompt, images, repoUrl, branch = 'main', model = 'composer-2' }) {
  /** @type {Record<string, any>} */
  const promptPayload = { text: prompt };
  if (images?.length) {
    promptPayload.images = images;
  }

  const t0 = Date.now();
  console.log(`[cursor-client] createAgent: calling POST /v1/agents (model=${model}, images=${images?.length ?? 0})`);

  const res = await fetch(`${CURSOR_API_BASE}/v1/agents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth(apiKey),
    },
    body: JSON.stringify({
      prompt: promptPayload,
      model: { id: model },
      repos: [{ url: repoUrl, startingRef: branch }],
      autoCreatePR: false,
    }),
  });

  console.log(`[cursor-client] createAgent: API responded ${res.status} in ${Date.now() - t0}ms`);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cursor API POST /v1/agents failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const agentId = data.agent?.id;
  const runId = data.run?.id || data.agent?.latestRunId;
  if (!agentId || !runId) {
    throw new Error(`Unexpected create agent response: ${JSON.stringify(data).slice(0, 200)}`);
  }
  console.log(`[cursor-client] createAgent: agentId=${agentId}, runId=${runId}`);
  return { agentId, runId };
}

/**
 * Create a follow-up run on an existing agent (for conversation continuity).
 * @param {Object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.agentId
 * @param {string} opts.prompt
 * @param {PromptImage[]} [opts.images]
 * @returns {Promise<{runId: string}>}
 */
export async function createFollowUpRun({ apiKey, agentId, prompt, images }) {
  /** @type {Record<string, any>} */
  const promptPayload = { text: prompt };
  if (images?.length) {
    promptPayload.images = images;
  }

  const t0 = Date.now();
  console.log(`[cursor-client] createFollowUpRun: calling POST /v1/agents/${agentId}/runs`);

  const res = await fetch(`${CURSOR_API_BASE}/v1/agents/${agentId}/runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth(apiKey),
    },
    body: JSON.stringify({
      prompt: promptPayload,
    }),
  });

  console.log(`[cursor-client] createFollowUpRun: API responded ${res.status} in ${Date.now() - t0}ms`);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cursor API POST /v1/agents/${agentId}/runs failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const runId = data.run?.id || data.id;
  if (!runId?.startsWith('run-')) {
    throw new Error(`Unexpected follow-up run response: ${JSON.stringify(data).slice(0, 200)}`);
  }
  console.log(`[cursor-client] createFollowUpRun: runId=${runId}`);
  return { runId };
}

/**
 * Stream a run's response via SSE and collect the assistant's text.
 * @param {Object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.agentId
 * @param {string} opts.runId
 * @param {number} [opts.timeoutMs=180000] - Max time to wait (default 3 min).
 * @returns {Promise<string>} The full assistant response text.
 */
export async function streamRunResponse({ apiKey, agentId, runId, timeoutMs = 180_000 }) {
  const t0 = Date.now();
  console.log(`[cursor-client] streamRunResponse: connecting to SSE stream for run=${runId}`);

  const res = await fetch(`${CURSOR_API_BASE}/v1/agents/${agentId}/runs/${runId}/stream`, {
    headers: {
      Accept: 'text/event-stream',
      Authorization: basicAuth(apiKey),
    },
  });

  console.log(`[cursor-client] streamRunResponse: SSE connected in ${Date.now() - t0}ms (status=${res.status})`);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cursor API stream failed (${res.status}): ${body}`);
  }

  const responseParts = [];
  let finished = false;
  let firstEventAt = 0;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      finished = true;
      reject(new Error('Cursor agent run timed out'));
    }, timeoutMs);

    const parser = createParser({
      onEvent(event) {
        if (finished) return;

        if (!firstEventAt) {
          firstEventAt = Date.now();
          console.log(`[cursor-client] streamRunResponse: first SSE event (type=${event.event}) at +${firstEventAt - t0}ms`);
        }

        if (event.event === 'assistant') {
          try {
            const data = JSON.parse(event.data);
            if (data.text) responseParts.push(data.text);
          } catch {
            // non-JSON assistant event, skip
          }
        }

        if (event.event === 'result' || event.event === 'done') {
          finished = true;
          clearTimeout(timeout);
          console.log(`[cursor-client] streamRunResponse: completed in ${Date.now() - t0}ms (${responseParts.length} chunks, ${responseParts.join('').length} chars)`);
          resolve(responseParts.join(''));
        }

        if (event.event === 'error') {
          finished = true;
          clearTimeout(timeout);
          console.log(`[cursor-client] streamRunResponse: error at +${Date.now() - t0}ms: ${event.data}`);
          reject(new Error(`Cursor agent error: ${event.data}`));
        }
      },
    });

    const reader = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader();
    const decoder = new TextDecoder();

    (async () => {
      try {
        while (!finished) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.feed(decoder.decode(value, { stream: true }));
        }
        if (!finished) {
          finished = true;
          clearTimeout(timeout);
          console.log(`[cursor-client] streamRunResponse: stream ended in ${Date.now() - t0}ms`);
          resolve(responseParts.join(''));
        }
      } catch (err) {
        if (!finished) {
          finished = true;
          clearTimeout(timeout);
          reject(err);
        }
      }
    })();
  });
}

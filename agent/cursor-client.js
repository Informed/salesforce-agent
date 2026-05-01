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
 * Create a new Cursor Cloud Agent and start an initial run.
 * @param {Object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.prompt
 * @param {string} opts.repoUrl
 * @param {string} [opts.branch='main']
 * @param {string} [opts.model='composer-2']
 * @returns {Promise<{agentId: string, runId: string}>}
 */
export async function createAgent({ apiKey, prompt, repoUrl, branch = 'main', model = 'composer-2' }) {
  const res = await fetch(`${CURSOR_API_BASE}/v1/agents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth(apiKey),
    },
    body: JSON.stringify({
      prompt: { text: prompt },
      model: { id: model },
      repos: [{ url: repoUrl, startingRef: branch }],
      autoCreatePR: false,
    }),
  });

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
  return { agentId, runId };
}

/**
 * Create a follow-up run on an existing agent (for conversation continuity).
 * @param {Object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.agentId
 * @param {string} opts.prompt
 * @returns {Promise<{runId: string}>}
 */
export async function createFollowUpRun({ apiKey, agentId, prompt }) {
  const res = await fetch(`${CURSOR_API_BASE}/v1/agents/${agentId}/runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth(apiKey),
    },
    body: JSON.stringify({
      prompt: { text: prompt },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cursor API POST /v1/agents/${agentId}/runs failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const runId = data.run?.id || data.id;
  if (!runId?.startsWith('run-')) {
    throw new Error(`Unexpected follow-up run response: ${JSON.stringify(data).slice(0, 200)}`);
  }
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
  const res = await fetch(`${CURSOR_API_BASE}/v1/agents/${agentId}/runs/${runId}/stream`, {
    headers: {
      Accept: 'text/event-stream',
      Authorization: basicAuth(apiKey),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cursor API stream failed (${res.status}): ${body}`);
  }

  const responseParts = [];
  let finished = false;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      finished = true;
      reject(new Error('Cursor agent run timed out'));
    }, timeoutMs);

    const parser = createParser({
      onEvent(event) {
        if (finished) return;

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
          resolve(responseParts.join(''));
        }

        if (event.event === 'error') {
          finished = true;
          clearTimeout(timeout);
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

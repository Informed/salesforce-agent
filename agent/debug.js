/**
 * Opt-in debug for the Slack → InvokeHarness path (Bolt process only).
 *
 * Set in `.env`: `SALESFORCE_AGENT_DEBUG=1`
 * Logs go to **stderr** → same terminal as `npm start` (alongside Bolt’s `[DEBUG]` lines).
 * They do **not** appear inside AgentCore / the harness VM unless you separately enable
 * harness-side logging (e.g. `SF_QUERY_DEBUG` on `sf-query.js`, if your runtime forwards it).
 */

/**
 * @returns {boolean}
 */
export function isSalesforceAgentDebug() {
  const v = process.env.SALESFORCE_AGENT_DEBUG?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * @param {unknown[]} args
 */
export function salesforceAgentDebug(...args) {
  if (!isSalesforceAgentDebug()) return;
  console.error('[salesforce-agent]', ...args);
}

/**
 * Region + short harness id (full ARN is long; account id partially masked).
 * @param {string} arn
 * @returns {string}
 */
export function shortHarnessArn(arn) {
  const m = /^arn:aws:bedrock-agentcore:([a-z0-9-]+):(\d+):harness\/(.+)$/i.exec(arn.trim());
  if (!m) return `${String(arn).slice(0, 48)}…`;
  const [, region, account, id] = m;
  const acct = account.length > 4 ? `…${account.slice(-4)}` : account;
  const hid = id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-8)}` : id;
  return `${region} account ${acct} harness/${hid}`;
}

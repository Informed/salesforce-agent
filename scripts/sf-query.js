#!/usr/bin/env node

/**
 * Standalone Salesforce query script.
 * Authenticates via JWT Bearer flow and runs a SOQL query.
 *
 * Usage:
 *   node scripts/sf-query.js "SELECT Id, Name, Amount FROM Opportunity LIMIT 10"
 *
 * Environment variables (set on the AgentCore harness / .env for local runs):
 *   SF_LOGIN_URL, SF_CLIENT_ID, SF_USERNAME, and one of SF_PRIVATE_KEY | SF_PRIVATE_KEY_BODY | SF_PRIVATE_KEY_FILE
 *
 * Debug (stderr only — does not break JSON on stdout):
 *   SF_QUERY_DEBUG=1  →  [sf-query] JSON lines: env lengths, stages, HTTP status on failure (no secrets).
 *   Harness: add SF_QUERY_DEBUG=1 to .env.harness, npm run merge-harness-env, push-harness-env, redeploy if needed.
 *   Local parity: npm run debug-sf-query
 */

import axios from 'axios';
import jwt from 'jsonwebtoken';

/**
 * @param {string} stage
 * @param {Record<string, unknown>} data
 */
function sfQueryDebug(stage, data) {
  const v = process.env.SF_QUERY_DEBUG?.trim().toLowerCase();
  if (v !== '1' && v !== 'true' && v !== 'yes') return;
  console.error(
    '[sf-query]',
    JSON.stringify({
      stage,
      pid: process.pid,
      cwd: process.cwd(),
      ...data,
    }),
  );
}

const SF_LOGIN_URL = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
const SF_CLIENT_ID = process.env.SF_CLIENT_ID;
const SF_USERNAME = process.env.SF_USERNAME;
const SF_PRIVATE_KEY = (() => {
  const body = process.env.SF_PRIVATE_KEY_BODY;
  if (body) {
    const cleaned = body.replace(/\s/g, '');
    const lines = cleaned.match(/.{1,64}/g) || [];
    return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`;
  }
  let key = process.env.SF_PRIVATE_KEY;
  if (!key) return undefined;
  key = key.replace(/^["']+|["']+$/g, '').trim();
  key = key.replace(/\\n/g, '\n');
  if (!key.includes('\n') && key.includes('-----')) {
    key = key
      .replace(/-----BEGIN ([\w ]+)-----/, '-----BEGIN $1-----\n')
      .replace(/-----END ([\w ]+)-----/, '\n-----END $1-----')
      .replace(/(.{64})(?!-)/g, '$1\n');
  }
  return key.trim();
})();

sfQueryDebug('after_key_resolve', {
  hasClientId: Boolean(String(SF_CLIENT_ID || '').trim()),
  hasUsername: Boolean(String(SF_USERNAME || '').trim()),
  clientIdLen: String(SF_CLIENT_ID || '').length,
  usernameLen: String(SF_USERNAME || '').length,
  privateKeyResolvedLen: SF_PRIVATE_KEY ? SF_PRIVATE_KEY.length : 0,
  privateKeySource: process.env.SF_PRIVATE_KEY_BODY
    ? 'SF_PRIVATE_KEY_BODY'
    : process.env.SF_PRIVATE_KEY
      ? 'SF_PRIVATE_KEY'
      : 'none',
  bodyRawLen: String(process.env.SF_PRIVATE_KEY_BODY || '').length,
  pemEnvRawLen: String(process.env.SF_PRIVATE_KEY || '').length,
  loginUrlHost: (() => {
    try {
      return new URL(SF_LOGIN_URL).hostname;
    } catch {
      return SF_LOGIN_URL;
    }
  })(),
});

if (!SF_CLIENT_ID || !SF_USERNAME || !SF_PRIVATE_KEY) {
  const missing = [];
  if (!String(SF_CLIENT_ID || '').trim()) missing.push('SF_CLIENT_ID');
  if (!String(SF_USERNAME || '').trim()) missing.push('SF_USERNAME');
  if (!SF_PRIVATE_KEY) {
    const hasBody = !!String(process.env.SF_PRIVATE_KEY_BODY || '').trim();
    const hasPem = !!String(process.env.SF_PRIVATE_KEY || '').trim();
    if (!hasBody && !hasPem)
      missing.push('SF_PRIVATE_KEY or SF_PRIVATE_KEY_BODY (or SF_PRIVATE_KEY_FILE via merge script)');
    else
      missing.push(
        'private key material present but PEM could not be built (check SF_PRIVATE_KEY_BODY / SF_PRIVATE_KEY format)',
      );
  }
  sfQueryDebug('exit_SF_ENV_MISSING', { missing });
  console.error(
    JSON.stringify({
      error: 'Salesforce JWT environment variables are not set in this process.',
      code: 'SF_ENV_MISSING',
      missing,
      hint: 'From repo root: fill .env.harness, npm run merge-harness-env, agentcore deploy, npm run push-harness-env. If you already pushed, start a NEW Slack thread (new harness session) or wait a minute and retry — old sessions may have started before env was applied.',
    }),
  );
  process.exit(1);
}

/**
 * Obtain a Salesforce access token via the JWT Bearer flow.
 * @returns {Promise<{accessToken: string, instanceUrl: string}>}
 */
async function authenticate() {
  const claim = {
    iss: SF_CLIENT_ID,
    sub: SF_USERNAME,
    aud: SF_LOGIN_URL,
    exp: Math.floor(Date.now() / 1000) + 300,
  };

  let assertion;
  try {
    assertion = jwt.sign(claim, SF_PRIVATE_KEY, { algorithm: 'RS256' });
    sfQueryDebug('jwt_sign_ok', { assertionLen: assertion.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    sfQueryDebug('jwt_sign_throw', { message: msg.slice(0, 300) });
    console.error(
      JSON.stringify({
        error: 'JWT signing failed — private key PEM is invalid or wrong format for RS256.',
        code: 'SF_JWT_SIGN_ERROR',
        detail: msg,
        hint: 'Use PKCS#8 PEM (BEGIN PRIVATE KEY) or SF_PRIVATE_KEY_BODY from that key. If the key is RSA PKCS#1 only, convert with openssl pkcs8 -topk8 -nocrypt.',
      }),
    );
    process.exit(1);
  }

  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  const tokenUrl = `${SF_LOGIN_URL}/services/oauth2/token`;
  sfQueryDebug('oauth_token_post', { tokenUrl: tokenUrl.slice(0, 80) });

  const res = await axios.post(tokenUrl, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  let instanceHost = '';
  try {
    instanceHost = res.data.instance_url ? new URL(res.data.instance_url).hostname : '';
  } catch {
    instanceHost = '(parse instance_url failed)';
  }
  sfQueryDebug('oauth_token_ok', { instanceHost, hasAccessToken: Boolean(res.data.access_token) });

  return {
    accessToken: res.data.access_token,
    instanceUrl: res.data.instance_url,
  };
}

/**
 * Run a SOQL query against Salesforce.
 * @param {string} soql
 * @param {string} accessToken
 * @param {string} instanceUrl
 * @returns {Promise<Object>}
 */
async function runQuery(soql, accessToken, instanceUrl) {
  const qUrl = `${instanceUrl}/services/data/v62.0/query`;
  sfQueryDebug('soql_request', { soqlChars: soql.length, queryApi: qUrl.slice(0, 60) });
  const res = await axios.get(qUrl, {
    params: { q: soql },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  sfQueryDebug('soql_ok', { totalSize: res.data?.totalSize, done: res.data?.done });
  return res.data;
}

async function main() {
  const soql = process.argv[2];
  if (!soql) {
    console.error(JSON.stringify({ error: 'Usage: node scripts/sf-query.js "<SOQL query>"' }));
    process.exit(1);
  }

  try {
    const { accessToken, instanceUrl } = await authenticate();
    const result = await runQuery(soql, accessToken, instanceUrl);

    console.log(
      JSON.stringify(
        {
          totalSize: result.totalSize,
          done: result.done,
          records: result.records.map((r) => {
            const { attributes, ...fields } = r;
            return fields;
          }),
        },
        null,
        2,
      ),
    );
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    const desc =
      typeof data === 'object' && data && 'error_description' in data
        ? String(data.error_description)
        : typeof data === 'string'
          ? data
          : err.message;
    sfQueryDebug('exit_SF_QUERY_ERROR', {
      httpStatus: status,
      axiosCode: err.code,
      messageHead: String(desc).slice(0, 400),
    });
    const message = err.response?.data?.error_description || err.response?.data || err.message;
    console.error(
      JSON.stringify({
        error: `Salesforce JWT or query failed: ${message}`,
        code: 'SF_QUERY_ERROR',
        hint: 'If this is invalid_grant / login errors, check Connected App certificate, permutations on sub (username), and SF_LOGIN_URL (login vs test). This is not fixed by push-harness-env alone.',
      }),
    );
    process.exit(1);
  }
}

main();

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
 *
 * Image fallback: `/app/.harness-salesforce-env.json` (and `../.harness-salesforce-env.json` next to this script)
 * is populated by `npm run merge-harness-env` and COPY’d in the harness Dockerfile. AgentCore often does not
 * inject harness `environmentVariables` into tool/shell subprocesses; loading this file fixes remote `sf-query`.
 *
 * AWS (recommended for production): set **`SF_SECRET_ID`** (Secrets Manager id or ARN) and/or **`SF_SSM_PARAMETER_NAME`**
 * so `sf-query` fetches a **JSON object** of `SF_*` strings at runtime (uses the harness/task IAM role).
 * **`AWS_REGION`** or **`AWS_DEFAULT_REGION`** must be set (AgentCore usually sets it).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import jwt from 'jsonwebtoken';

const __dirname_sf = path.dirname(fileURLToPath(import.meta.url));

/**
 * @returns {{ loaded: boolean; path?: string }}
 */
function applyHarnessSalesforceEnvFile() {
  const candidates = [
    '/app/.harness-salesforce-env.json',
    path.join(__dirname_sf, '..', '.harness-salesforce-env.json'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw = fs.readFileSync(p, 'utf8').trim();
      if (!raw || raw === '{}') continue;
      const o = JSON.parse(raw);
      if (!o || typeof o !== 'object') continue;
      const keys = [
        'SF_LOGIN_URL',
        'SF_CLIENT_ID',
        'SF_USERNAME',
        'SF_PRIVATE_KEY',
        'SF_PRIVATE_KEY_BODY',
        'SF_QUERY_DEBUG',
      ];
      for (const k of keys) {
        const v = o[k];
        if (typeof v === 'string' && v.length > 0) process.env[k] = v;
      }
      return { loaded: true, path: p };
    } catch {
      /* try next path */
    }
  }
  return { loaded: false };
}

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

/**
 * Merge JSON object keys into process.env (Secrets Manager / SSM payloads).
 * @param {unknown} o
 * @param {string} sourceLabel
 */
function mergeSfEnvFromAwsJson(o, sourceLabel) {
  if (!o || typeof o !== 'object') return;
  const override = process.env.SF_AWS_CREDS_OVERRIDE === '1';
  let applied = 0;
  for (const [k, v] of Object.entries(o)) {
    if (!/^SF_[A-Z0-9_]+$/.test(k)) continue;
    if (typeof v !== 'string' || v.length === 0) continue;
    if (!process.env[k] || override) {
      process.env[k] = v;
      applied++;
    }
  }
  sfQueryDebug('env_from_aws_json', { source: sourceLabel, keysApplied: applied });
}

/**
 * Load JWT-related env from Secrets Manager (`SF_SECRET_ID`) and/or SSM (`SF_SSM_PARAMETER_NAME`).
 */
async function loadSalesforceCredentialsFromAws() {
  const secretId = process.env.SF_SECRET_ID?.trim();
  const ssmName = process.env.SF_SSM_PARAMETER_NAME?.trim();
  if (!secretId && !ssmName) return;

  const region = (process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || process.env.SF_AWS_REGION || '').trim();
  if (!region) {
    console.error(
      JSON.stringify({
        error:
          'SF_SECRET_ID or SF_SSM_PARAMETER_NAME is set but AWS_REGION / AWS_DEFAULT_REGION / SF_AWS_REGION is missing.',
        code: 'SF_AWS_REGION_MISSING',
      }),
    );
    process.exit(1);
  }

  sfQueryDebug('aws_fetch_start', { region, hasSecretId: Boolean(secretId), hasSsm: Boolean(ssmName) });

  try {
    if (secretId) {
      const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
      const client = new SecretsManagerClient({ region });
      const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      const str = res.SecretString;
      if (!str) {
        console.error(
          JSON.stringify({ error: 'Secrets Manager returned empty SecretString', code: 'SF_SECRET_EMPTY' }),
        );
        process.exit(1);
      }
      let parsed;
      try {
        parsed = JSON.parse(str);
      } catch {
        console.error(
          JSON.stringify({
            error:
              'Secrets Manager secret must be JSON with SF_* keys (e.g. SF_CLIENT_ID, SF_USERNAME, SF_PRIVATE_KEY_BODY).',
            code: 'SF_SECRET_JSON',
          }),
        );
        process.exit(1);
      }
      mergeSfEnvFromAwsJson(parsed, 'secretsmanager');
    }

    if (ssmName) {
      const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
      const client = new SSMClient({ region });
      const res = await client.send(new GetParameterCommand({ Name: ssmName, WithDecryption: true }));
      const str = res.Parameter?.Value;
      if (!str) {
        console.error(JSON.stringify({ error: 'SSM parameter value empty', code: 'SF_SSM_EMPTY' }));
        process.exit(1);
      }
      let parsed;
      try {
        parsed = JSON.parse(str);
      } catch {
        console.error(
          JSON.stringify({
            error: 'SSM parameter must be JSON with SF_* keys (SecureString recommended).',
            code: 'SF_SSM_JSON',
          }),
        );
        process.exit(1);
      }
      mergeSfEnvFromAwsJson(parsed, 'ssm');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : 'Error';
    console.error(
      JSON.stringify({
        error: `AWS credential fetch failed: ${msg}`,
        code: 'SF_AWS_FETCH_ERROR',
        name,
        hint: 'Grant the harness execution role secretsmanager:GetSecretValue on the secret and/or ssm:GetParameter on the parameter; for SecureString use kms:Decrypt on the key.',
      }),
    );
    process.exit(1);
  }
}

const harnessSalesforceEnvFile = applyHarnessSalesforceEnvFile();
await loadSalesforceCredentialsFromAws();

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
  harnessSalesforceEnvFile: harnessSalesforceEnvFile.loaded ? harnessSalesforceEnvFile.path : '(not used or empty {})',
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
      hint: 'Set JWT via .env.harness merge, OR SF_SECRET_ID / SF_SSM_PARAMETER_NAME pointing at JSON in Secrets Manager / SSM (see README). Then merge-harness-env, deploy image, push-harness-env. Ensure AWS_REGION and IAM GetSecretValue/GetParameter.',
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

main().catch((err) => {
  console.error(JSON.stringify({ error: String(err?.message || err), code: 'SF_FATAL' }));
  process.exit(1);
});

#!/usr/bin/env node

/**
 * Standalone Salesforce query script.
 * Authenticates via JWT Bearer flow and runs a SOQL query.
 *
 * Usage:
 *   node scripts/sf-query.js "SELECT Id, Name, Amount FROM Opportunity LIMIT 10"
 *
 * Environment variables (set via Cursor Secrets or .env):
 *   SF_LOGIN_URL, SF_CLIENT_ID, SF_USERNAME, SF_PRIVATE_KEY
 */

import jwt from 'jsonwebtoken';
import axios from 'axios';

const SF_LOGIN_URL = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
const SF_CLIENT_ID = process.env.SF_CLIENT_ID;
const SF_USERNAME = process.env.SF_USERNAME;
const SF_PRIVATE_KEY = (() => {
  let key = process.env.SF_PRIVATE_KEY;
  if (!key) return undefined;
  key = key.replace(/^["']+|["']+$/g, '');
  key = key.replace(/\\n/g, '\n');
  if (!key.includes('\n') && key.includes('-----')) {
    key = key
      .replace(/-----BEGIN ([\w ]+)-----/, '-----BEGIN $1-----\n')
      .replace(/-----END ([\w ]+)-----/, '\n-----END $1-----')
      .replace(/(.{64})(?!-)/g, '$1\n');
  }
  return key.trim();
})();

// Diagnostic: show key format (first/last 20 chars only, not the actual key)
if (SF_PRIVATE_KEY) {
  const raw = process.env.SF_PRIVATE_KEY || '';
  console.error(JSON.stringify({
    debug_key_info: {
      raw_length: raw.length,
      raw_starts_with: raw.slice(0, 30),
      raw_has_backslash_n: raw.includes('\\n'),
      raw_has_real_newline: raw.includes('\n'),
      parsed_length: SF_PRIVATE_KEY.length,
      parsed_starts_with: SF_PRIVATE_KEY.slice(0, 30),
      parsed_has_newlines: SF_PRIVATE_KEY.includes('\n'),
      parsed_newline_count: (SF_PRIVATE_KEY.match(/\n/g) || []).length,
    },
  }));
}

if (!SF_CLIENT_ID || !SF_USERNAME || !SF_PRIVATE_KEY) {
  console.error(JSON.stringify({
    error: 'Missing Salesforce credentials. Set SF_CLIENT_ID, SF_USERNAME, and SF_PRIVATE_KEY.',
  }));
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

  const assertion = jwt.sign(claim, SF_PRIVATE_KEY, { algorithm: 'RS256' });

  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  const res = await axios.post(`${SF_LOGIN_URL}/services/oauth2/token`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

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
  const res = await axios.get(`${instanceUrl}/services/data/v62.0/query`, {
    params: { q: soql },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
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

    console.log(JSON.stringify({
      totalSize: result.totalSize,
      done: result.done,
      records: result.records.map((r) => {
        const { attributes, ...fields } = r;
        return fields;
      }),
    }, null, 2));
  } catch (err) {
    const message = err.response?.data?.error_description || err.response?.data || err.message;
    console.error(JSON.stringify({ error: `Salesforce query failed: ${message}` }));
    process.exit(1);
  }
}

main();

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
    const data = err.response?.data;
    const message = typeof data === 'string' ? data : data?.error_description || (data ? JSON.stringify(data) : err.message);
    console.error(JSON.stringify({ error: `Salesforce query failed: ${message}` }));
    process.exit(1);
  }
}

main();

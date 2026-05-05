#!/usr/bin/env node

import jwt from 'jsonwebtoken';
import axios from 'axios';

const SF_LOGIN_URL = process.env.SF_LOGIN_URL;
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
  return { accessToken: res.data.access_token, instanceUrl: res.data.instance_url };
}

async function runQuery(soql, accessToken, instanceUrl) {
  const res = await axios.get(`${instanceUrl}/services/data/v62.0/query`, {
    params: { q: soql },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.data;
}

async function main() {
  const { accessToken, instanceUrl } = await authenticate();

  // Step 1: Get distinct contact IDs who replied to ML Live emails this week
  const tasksResult = await runQuery(
    "SELECT WhoId, Who.Name FROM Task WHERE Subject LIKE '%Re:%' AND Subject LIKE '%ML Live%' AND CreatedDate = THIS_WEEK AND Who.Type = 'Contact' GROUP BY WhoId, Who.Name ORDER BY Who.Name",
    accessToken, instanceUrl
  );
  const contactIds = tasksResult.records.map(r => r.WhoId);

  // Step 2: Get contact details with accounts (batch in groups of 50)
  const contacts = [];
  for (let i = 0; i < contactIds.length; i += 50) {
    const batch = contactIds.slice(i, i + 50);
    const idList = batch.map(id => `'${id}'`).join(',');
    const result = await runQuery(
      `SELECT Id, Name, Account.Name, AccountId FROM Contact WHERE Id IN (${idList})`,
      accessToken, instanceUrl
    );
    contacts.push(...result.records);
  }

  // Filter to credit union accounts
  const cuContacts = contacts.filter(c => {
    const acctName = (c.Account?.Name || '').toLowerCase();
    return acctName.includes('credit union') || acctName.includes('c.u.') || acctName.includes(' cu') || acctName.includes(' fcu');
  });

  // Step 3: Get distinct account IDs
  const accountIds = [...new Set(cuContacts.map(c => c.AccountId).filter(Boolean))];

  // Step 4: Check which accounts have open opportunities
  const acctWithOpps = new Set();
  for (let i = 0; i < accountIds.length; i += 50) {
    const batch = accountIds.slice(i, i + 50);
    const idList = batch.map(id => `'${id}'`).join(',');
    const result = await runQuery(
      `SELECT AccountId FROM Opportunity WHERE AccountId IN (${idList}) AND IsClosed = false GROUP BY AccountId`,
      accessToken, instanceUrl
    );
    result.records.forEach(r => acctWithOpps.add(r.AccountId));
  }

  // Step 5: Filter to contacts whose accounts do NOT have open opportunities
  const noOppContacts = cuContacts.filter(c => !acctWithOpps.has(c.AccountId));

  // Group by account
  const byAccount = {};
  for (const c of noOppContacts) {
    const acctName = c.Account?.Name || 'Unknown';
    if (!byAccount[acctName]) byAccount[acctName] = [];
    byAccount[acctName].push(c.Name);
  }

  console.log(JSON.stringify({
    totalRespondents: contactIds.length,
    creditUnionRespondents: cuContacts.length,
    creditUnionsWithOpenOpps: acctWithOpps.size,
    creditUnionsWithoutOpenOpps: Object.keys(byAccount).length,
    contactsWithoutOpenOpps: noOppContacts.length,
    byAccount
  }, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});

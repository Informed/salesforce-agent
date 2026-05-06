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

const INPUT_NAMES = [
  "APPLE FCU",
  "Abbey Credit Union",
  "Alliant Credit Union",
  "America's First FCU",
  "American Heritage FCU",
  "Associated CU of TX",
  "Austin Federal Credit Union",
  "Benchmark FCU",
  "Beneficial State Bank",
  "Best Financial CU",
  "Boeing Employees CU",
  "Capitol Credit Union",
  "Chief Financial Credit Union",
  "Commonwealth FCU",
  "Consumer Portfolio Services, Inc.",
  "Consumers Credit Union",
  "Consumers Credit Union - Purchase New",
  "Consumers Credit Union - Purchase Used",
  "Credit Union West",
  "DATCU Credit Union",
  "Directions CU",
  "Dover Federal Credit Union",
  "Energy Plus Credit Union",
  "Exeter Finance, LLC",
  "Financial Center First Credit Union",
  "Financial Partners Credit Union",
  "Firefighters Community CU",
  "First CU (AZ)",
  "First Florida CU",
  "First Help Financial",
  "First Service CU (TX)",
  "First Service FCU (OH)",
  "Flagship",
  "Foursight Capital, LLC",
  "Franklin Mint FCU",
  "Gain Federal Credit Union",
  "Global Lending Services",
  "Go Energy Financial Credit Union",
  "Greater Texas Credit Union",
  "Guardian CU",
  "Hudson Valley Credit Union",
  "Island FCU",
  "Kemba Roanoke FCU",
  "LA Federal Credit Union",
  "Lendbuzz Funding LLC",
  "Liberty Federal Credit Union",
  "Lone Star Credit Union",
  "Matadors CCU",
  "Members Advantage Credit Union",
  "Meritrust Federal Credit Union",
  "Mobility Credit Union",
  "Money One FCU",
  "Mutual 1st Federal",
  "MyPoint Credit Union",
  "NASA Federal Credit Union",
  "North Coast CU",
  "Nutmeg State FCU",
  "Oklahoma Educators Credit Union",
  "OpenRoad Lending",
  "Orion Federal Credit Union",
  "PSE CU",
  "PenFed Credit Union",
  "Peninsula Community FCU",
  "Philadelphia Federal Credit Union",
  "Regional Acceptance Corporation",
  "Sierra Central CU",
  "Southwest 66 Credit Union",
  "Tampa Bay Federal Credit Union",
  "Tarrant County's Credit Union",
  "Texas Bay Credit Union",
  "Tower Federal CU",
  "Tropical Financial CU",
  "UBI Federal Credit Union",
  "USE Credit Union",
  "Velocity CU",
  "VyStar Credit Union",
  "Webster First FCU",
  "Wellby Financial",
  "Wright Patt CU",
];

async function main() {
  const { accessToken, instanceUrl } = await authenticate();

  // Step 1: Get all Account names from SFDC to do fuzzy matching
  const allAccountsResult = await runQuery(
    "SELECT Id, Name FROM Account ORDER BY Name",
    accessToken,
    instanceUrl
  );
  const sfdcAccounts = allAccountsResult.records.map(r => ({ id: r.Id, name: r.Name }));
  
  // Build lookup maps - exact match and lowercase match
  const exactMap = new Map();
  const lowerMap = new Map();
  for (const acct of sfdcAccounts) {
    exactMap.set(acct.name, acct);
    lowerMap.set(acct.name.toLowerCase(), acct);
  }

  // Match each input name
  const matched = [];
  const unmatched = [];
  
  for (const name of INPUT_NAMES) {
    let match = exactMap.get(name);
    if (!match) match = lowerMap.get(name.toLowerCase());
    if (match) {
      matched.push({ inputName: name, sfdcName: match.name, sfdcId: match.id });
    } else {
      unmatched.push(name);
    }
  }

  // Step 2: For matched accounts, get Closed Won opportunity dates
  if (matched.length > 0) {
    const accountIds = matched.map(m => `'${m.sfdcId}'`).join(',');
    const oppQuery = `SELECT AccountId, Account.Name, CloseDate FROM Opportunity WHERE IsWon = true AND AccountId IN (${accountIds}) ORDER BY CloseDate DESC`;
    const oppResult = await runQuery(oppQuery, accessToken, instanceUrl);
    
    // Build a map of accountId -> most recent close date
    const closeDateMap = new Map();
    for (const opp of oppResult.records) {
      const acctId = opp.AccountId;
      if (!closeDateMap.has(acctId)) {
        closeDateMap.set(acctId, opp.CloseDate);
      }
    }
    
    // Attach close dates to matches
    for (const m of matched) {
      m.closedWonDate = closeDateMap.get(m.sfdcId) || null;
    }
  }

  console.log(JSON.stringify({ matched, unmatched }, null, 2));
}

main().catch(err => {
  console.error('Error:', err.response?.data || err.message);
  process.exit(1);
});

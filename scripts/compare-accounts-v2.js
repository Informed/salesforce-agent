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

let accessToken, instanceUrl;

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
  accessToken = res.data.access_token;
  instanceUrl = res.data.instance_url;
}

async function runQuery(soql) {
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

function escSoql(s) {
  return s.replace(/'/g, "\\'");
}

async function main() {
  await authenticate();

  // Step 1: Get ALL accounts from SFDC
  let allAccounts = [];
  let queryUrl = `${instanceUrl}/services/data/v62.0/query?q=${encodeURIComponent("SELECT Id, Name FROM Account ORDER BY Name")}`;
  
  while (queryUrl) {
    const res = await axios.get(queryUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    allAccounts = allAccounts.concat(res.data.records.map(r => ({ id: r.Id, name: r.Name })));
    queryUrl = res.data.nextRecordsUrl ? `${instanceUrl}${res.data.nextRecordsUrl}` : null;
  }
  
  console.error(`Total SFDC accounts: ${allAccounts.length}`);

  // Build lookup maps
  const lowerMap = new Map();
  for (const acct of allAccounts) {
    const key = acct.name.toLowerCase().trim();
    if (!lowerMap.has(key)) lowerMap.set(key, acct);
  }

  // Normalize function - strip common variations
  function normalize(name) {
    return name
      .toLowerCase()
      .replace(/['']/g, "'")
      .replace(/,?\s*(inc\.|llc|corp\.?|ltd\.?)$/i, '')
      .trim();
  }

  // Also build a normalized map
  const normMap = new Map();
  for (const acct of allAccounts) {
    const key = normalize(acct.name);
    if (!normMap.has(key)) normMap.set(key, acct);
  }

  // Try matching with various strategies
  const results = [];
  
  for (const inputName of INPUT_NAMES) {
    let match = null;
    let matchType = '';
    
    // Strategy 1: Exact case-insensitive
    const lower = inputName.toLowerCase().trim();
    if (lowerMap.has(lower)) {
      match = lowerMap.get(lower);
      matchType = 'exact';
    }
    
    // Strategy 2: Normalized match
    if (!match) {
      const norm = normalize(inputName);
      if (normMap.has(norm)) {
        match = normMap.get(norm);
        matchType = 'normalized';
      }
    }
    
    // Strategy 3: Contains-based fuzzy matching
    if (!match) {
      const inputLower = inputName.toLowerCase();
      // Try to find accounts that contain the input name or vice versa
      for (const acct of allAccounts) {
        const acctLower = acct.name.toLowerCase();
        if (acctLower.includes(inputLower) || inputLower.includes(acctLower)) {
          match = acct;
          matchType = 'contains';
          break;
        }
      }
    }

    // Strategy 4: Keyword matching for credit union names
    if (!match) {
      // Extract meaningful keywords (skip common words like "credit", "union", "federal", etc.)
      const skipWords = new Set(['credit', 'union', 'federal', 'cu', 'fcu', 'ccu', 'community', 'the', 'of', 'and', '&', 'employees', 'financial', 'savings', 'bank', 'llc', 'inc', 'inc.', 'corp', 'state']);
      const inputWords = inputName.toLowerCase().replace(/[(),-]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !skipWords.has(w));
      
      if (inputWords.length > 0) {
        let bestMatch = null;
        let bestScore = 0;
        
        for (const acct of allAccounts) {
          const acctLower = acct.name.toLowerCase();
          let score = 0;
          for (const word of inputWords) {
            if (acctLower.includes(word)) score++;
          }
          const ratio = score / inputWords.length;
          if (ratio > bestScore && ratio >= 0.5) {
            bestScore = ratio;
            bestMatch = acct;
          }
        }
        
        if (bestMatch && bestScore >= 0.5) {
          match = bestMatch;
          matchType = `keyword(${Math.round(bestScore * 100)}%)`;
        }
      }
    }
    
    results.push({
      inputName,
      sfdcMatch: match ? match.name : null,
      sfdcId: match ? match.id : null,
      matchType: match ? matchType : 'none',
    });
  }

  // Step 2: For matched accounts, get Closed Won dates
  const matchedIds = results.filter(r => r.sfdcId).map(r => r.sfdcId);
  const closeDateMap = new Map();
  
  if (matchedIds.length > 0) {
    // Query in batches of 50
    for (let i = 0; i < matchedIds.length; i += 50) {
      const batch = matchedIds.slice(i, i + 50);
      const idList = batch.map(id => `'${id}'`).join(',');
      const oppQuery = `SELECT AccountId, CloseDate FROM Opportunity WHERE IsWon = true AND AccountId IN (${idList}) ORDER BY CloseDate DESC`;
      const oppResult = await runQuery(oppQuery);
      for (const opp of oppResult.records) {
        if (!closeDateMap.has(opp.AccountId)) {
          closeDateMap.set(opp.AccountId, opp.CloseDate);
        }
      }
    }
  }

  // Final output
  for (const r of results) {
    r.closedWonDate = r.sfdcId ? (closeDateMap.get(r.sfdcId) || null) : null;
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error('Error:', err.response?.data || err.message);
  process.exit(1);
});

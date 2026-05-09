#!/usr/bin/env node
/**
 * Push harness.json → environmentVariables to the deployed harness via UpdateHarness.
 * Some agentcore deploy/CDK paths provision the execution role + image but do not
 * apply env vars from harness.json to the control plane; InvokeHarness then runs with
 * empty SF_* inside the container even though local sf-query works with the same JSON.
 *
 * Prereqs: AWS credentials, HARNESS_ARN in .env (or env), merge-harness-env already run.
 *
 * Usage:
 *   npm run push-harness-env
 *   npm run push-harness-env -- /path/to/agentcore-project
 */
// biome-ignore assist/source/organizeImports: keep file header before external imports
import {
  BedrockAgentCoreControlClient,
  GetHarnessCommand,
  UpdateHarnessCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { config as loadEnv } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.join(repoRoot, '.env') });

const rawArgs = process.argv.slice(2);
const projectRootArg = rawArgs.find((a) => !a.startsWith('-'));
const agentCoreRoot = path.resolve(repoRoot, projectRootArg || 'salesforceAgent00');
const specPath = path.join(agentCoreRoot, 'agentcore', 'agentcore.json');

if (!fs.existsSync(specPath)) {
  console.error(`Missing ${specPath}`);
  process.exit(1);
}

function harnessJsonPath() {
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const h = spec.harnesses?.[0];
  if (!h?.path) throw new Error(`Missing harnesses[0].path in ${specPath}`);
  return path.join(agentCoreRoot, h.path, 'harness.json');
}

/**
 * @param {string} arn
 */
function harnessIdFromArn(arn) {
  const m = /^arn:aws:bedrock-agentcore:[a-z0-9-]+:\d+:harness\/(.+)$/i.exec(arn.trim());
  if (!m) {
    throw new Error(
      `HARNESS_ARN must look like arn:aws:bedrock-agentcore:REGION:ACCOUNT:harness/HARNESS_ID (got ${JSON.stringify(arn?.slice(0, 60))}…)`,
    );
  }
  return m[1];
}

/**
 * @param {string} arn
 */
function regionFromHarnessArn(arn) {
  const m = /^arn:aws:bedrock-agentcore:([a-z0-9-]+):/i.exec(arn);
  return m?.[1];
}

const harnessArn = process.env.HARNESS_ARN;
if (!harnessArn) {
  console.error('Set HARNESS_ARN in .env (or export it) before running this script.');
  process.exit(1);
}

const harnessId = harnessIdFromArn(harnessArn);
const region = process.env.AWS_REGION || regionFromHarnessArn(harnessArn);
if (!region) {
  console.error('Could not derive region: set AWS_REGION or use a full harness ARN in HARNESS_ARN.');
  process.exit(1);
}

const harnessPath = harnessJsonPath();
if (!fs.existsSync(harnessPath)) {
  console.error(`Missing ${harnessPath}`);
  process.exit(1);
}

const spec = JSON.parse(fs.readFileSync(harnessPath, 'utf8'));
const environmentVariables = spec.environmentVariables;

if (
  !environmentVariables ||
  typeof environmentVariables !== 'object' ||
  Object.keys(environmentVariables).length === 0
) {
  console.error(`No environmentVariables in ${harnessPath}. Run: npm run merge-harness-env`);
  process.exit(1);
}

const hasAwsPointer =
  Boolean(String(environmentVariables.SF_SECRET_ID || '').trim()) ||
  Boolean(String(environmentVariables.SF_SSM_PARAMETER_NAME || '').trim());
const hasKey = Boolean(environmentVariables.SF_PRIVATE_KEY || environmentVariables.SF_PRIVATE_KEY_BODY);

if (!hasAwsPointer) {
  const requiredSf = ['SF_CLIENT_ID', 'SF_USERNAME'];
  const missing = requiredSf.filter((k) => !environmentVariables[k]);
  if (missing.length || !hasKey) {
    const need = [...missing];
    if (!hasKey) need.push('SF_PRIVATE_KEY or SF_PRIVATE_KEY_BODY');
    console.error(`harness.json environmentVariables missing ${need.join(', ')}`);
    process.exit(1);
  }
} else {
  console.warn(
    'Push: expecting JWT from AWS (SF_SECRET_ID / SF_SSM_PARAMETER_NAME); not requiring SF_CLIENT_ID / SF_USERNAME / key in harness.json.',
  );
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Transitional states right after UpdateHarness — a single GetHarness often stays UPDATING. */
const HARNESS_WAIT_STATUSES = new Set(['UPDATING', 'CREATING']);

/**
 * @param {import('@aws-sdk/client-bedrock-agentcore-control').BedrockAgentCoreControlClient} controlClient
 * @param {string} id
 */
async function getHarnessWhenStable(controlClient, id) {
  const pollMs = 3000;
  const maxWaitMs = 180_000;
  const t0 = Date.now();
  let remote = await controlClient.send(new GetHarnessCommand({ harnessId: id }));
  let status = remote.harness?.status ?? '';
  while (HARNESS_WAIT_STATUSES.has(status) && Date.now() - t0 < maxWaitMs) {
    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.log(
      `GetHarness: status=${status} — waiting for READY or ACTIVE (${elapsed}s / ${maxWaitMs / 1000}s max)…`,
    );
    await sleep(pollMs);
    remote = await controlClient.send(new GetHarnessCommand({ harnessId: id }));
    status = remote.harness?.status ?? '';
  }
  if (HARNESS_WAIT_STATUSES.has(status)) {
    console.warn(
      `GetHarness: still ${status} after ${maxWaitMs / 1000}s. AWS may need more time — wait 1–2 minutes, then run \`npm run push-harness-env\` again (no-op update) or \`cd salesforceAgent00 && agentcore status\`.`,
    );
  }
  return remote;
}

const client = new BedrockAgentCoreControlClient({ region });
await client.send(
  new UpdateHarnessCommand({
    harnessId,
    environmentVariables,
  }),
);

console.log(`Updated harness ${harnessId} (${region}) environmentVariables from ${harnessPath}`);
console.log(`Keys: ${Object.keys(environmentVariables).sort().join(', ')}`);

const remote = await getHarnessWhenStable(client, harnessId);
const arn = remote.harness?.arn;
const status = remote.harness?.status;
const remoteEnv = remote.harness?.environmentVariables || {};
const sfKeys = Object.keys(remoteEnv)
  .filter((k) => k.startsWith('SF_'))
  .sort();
console.log(`GetHarness: status=${status ?? '?'}${arn ? ` arn=${arn}` : ''}`);
if (status === 'READY' || status === 'ACTIVE') {
  console.log('Harness env update finished (READY/ACTIVE) — safe to retry Slack after restarting npm start if you changed Bolt code.');
  console.log(
    'Slack reuses the same AgentCore session per thread: if sf-query still shows SF_ENV_MISSING in Slack, set HARNESS_RUNTIME_SESSION_SALT in .env to a NEW value, restart npm start, then send your question again (same thread is OK).',
  );
}
if (sfKeys.length === 0) {
  console.warn(
    'WARNING: GetHarness returned no SF_* keys. Wrong harnessId/region/account, API redaction, or update still propagating — re-check HARNESS_ARN and AWS credentials.',
  );
} else {
  for (const k of sfKeys) {
    const v = remoteEnv[k];
    console.log(`  ${k}: length=${typeof v === 'string' ? v.length : 0}`);
  }
}
console.log(
  'If Slack still reports missing SF_* after this, set HARNESS_RUNTIME_SESSION_SALT to a new value in .env, restart npm start, and retry (or start a new assistant thread).',
);

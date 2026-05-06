#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * Merge SF_* into AgentCore harness.json → environmentVariables.
 * Bolt's .env is never sent to AWS; only harness.json (at deploy) supplies env to the container.
 *
 * Usage:
 *   npm run merge-harness-env
 *   npm run merge-harness-env -- /path/to/agentcore-project
 *   npm run merge-harness-env -- --clear   # strip SF secrets from harness.json (safe for git)
 */
import { parse } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const rawArgs = process.argv.slice(2);
const clearOnly = rawArgs.includes('--clear');
const projectRootArg = rawArgs.find((a) => !a.startsWith('-'));
const agentCoreRoot = path.resolve(repoRoot, projectRootArg || 'salesforceAgent00');
const specPath = path.join(agentCoreRoot, 'agentcore', 'agentcore.json');

const MAX_ENV_VALUE_LEN = 5000; // Bedrock AgentCore harness env map limit per key

function harnessJsonPath() {
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const h = spec.harnesses?.[0];
  if (!h?.path) {
    throw new Error(`Missing harnesses[0].path in ${specPath}`);
  }
  return path.join(agentCoreRoot, h.path, 'harness.json');
}

const harnessPath = harnessJsonPath();
/** Baked into the harness Docker image; sf-query loads it when control-plane env is missing in tool shells. */
const harnessEnvFilePath = path.join(path.dirname(harnessPath), '.harness-salesforce-env.json');
const envCandidates = [path.join(agentCoreRoot, '.env.harness'), path.join(repoRoot, '.env.harness')];
const envPath = envCandidates.find((p) => fs.existsSync(p));

const SF_SECRET_KEYS = ['SF_CLIENT_ID', 'SF_USERNAME', 'SF_PRIVATE_KEY', 'SF_PRIVATE_KEY_BODY'];
/** Cleared with --clear; includes AWS pointers so git commits stay safe. */
const SF_AWS_POINTER_KEYS = ['SF_SECRET_ID', 'SF_SSM_PARAMETER_NAME', 'SF_AWS_CREDS_OVERRIDE', 'SF_AWS_REGION'];
const SF_ALL_KEYS = [
  'SF_LOGIN_URL',
  ...SF_SECRET_KEYS,
  'SF_PRIVATE_KEY_FILE',
  'SF_QUERY_DEBUG',
  ...SF_AWS_POINTER_KEYS,
];

function pemLooksComplete(s) {
  if (!s) return false;
  const hasEnd = s.includes('END PRIVATE KEY') || s.includes('END RSA PRIVATE KEY');
  return hasEnd;
}

/**
 * dotenv.parse() only returns the first line for unquoted multiline values.
 * Re-read SF_PRIVATE_KEY from raw file when PEM is clearly truncated.
 * @param {string} raw
 * @param {Record<string, string>} parsed
 */
function expandUnquotedMultilinePrivateKey(raw, parsed) {
  const v = parsed.SF_PRIVATE_KEY;
  if (!v?.includes('BEGIN')) return;
  if (pemLooksComplete(v)) return;

  const lines = raw.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^SF_PRIVATE_KEY=/.test(l));
  if (idx === -1) return;

  const afterEq = lines[idx].replace(/^SF_PRIVATE_KEY=\s*/, '');
  const trimmedStart = afterEq.trimStart();
  if (trimmedStart.startsWith('"') || trimmedStart.startsWith("'")) {
    return;
  }

  let acc = afterEq.replace(/\s+$/, '');
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) break;
    acc += `\n${line}`;
    if (pemLooksComplete(acc)) break;
  }

  if (pemLooksComplete(acc)) {
    parsed.SF_PRIVATE_KEY = acc.trim();
  }
}

/**
 * @param {string} v
 */
function stripSurroundingQuotes(v) {
  let s = v.trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    s = s.slice(1, -1).replace(/\\n/g, '\n');
  }
  return s.trim();
}

/**
 * @param {string} envPath
 * @param {Record<string, string>} parsed
 */
function resolvePrivateKeyFile(envPath, parsed) {
  const rel = parsed.SF_PRIVATE_KEY_FILE?.trim();
  if (!rel) return;
  if (parsed.SF_PRIVATE_KEY || parsed.SF_PRIVATE_KEY_BODY) {
    console.warn('Ignoring SF_PRIVATE_KEY_FILE because SF_PRIVATE_KEY or SF_PRIVATE_KEY_BODY is set.');
    return;
  }
  const resolved = path.isAbsolute(rel) ? rel : path.join(path.dirname(envPath), rel);
  if (!fs.existsSync(resolved)) {
    console.error(`SF_PRIVATE_KEY_FILE not found: ${resolved}`);
    process.exit(1);
  }
  parsed.SF_PRIVATE_KEY = fs.readFileSync(resolved, 'utf8').trim();
}

/**
 * @param {string} label
 * @param {string} value
 */
function assertEnvValueLength(label, value) {
  if (value && value.length > MAX_ENV_VALUE_LEN) {
    console.error(
      `${label} is ${value.length} characters; AgentCore allows at most ${MAX_ENV_VALUE_LEN} per environment variable. Use SF_PRIVATE_KEY_BODY (base64 PEM body, one line) instead of a full multi-line PEM in harness.json, or shorten the key material.`,
    );
    process.exit(1);
  }
}

/**
 * @param {string | undefined} pem
 */
function assertPrivateKeyUsable(pem) {
  if (!pem) return;
  const s = stripSurroundingQuotes(pem);
  if (s.includes('BEGIN') && !pemLooksComplete(s)) {
    console.error(
      [
        'SF_PRIVATE_KEY looks truncated (found BEGIN but no END PRIVATE KEY / END RSA PRIVATE KEY).',
        'Fix one of:',
        '  • In .env.harness put the PEM in double quotes spanning multiple lines,',
        '  • Or use SF_PRIVATE_KEY_FILE=./relative-or-absolute-path.pem,',
        '  • Or use SF_PRIVATE_KEY_BODY= (PEM body only, base64 one line — best for AgentCore env size limits).',
      ].join('\n'),
    );
    process.exit(1);
  }
}

function clear() {
  const harness = JSON.parse(fs.readFileSync(harnessPath, 'utf8'));
  const prev = harness.environmentVariables || {};
  const next = { ...prev };
  for (const k of [...SF_SECRET_KEYS, ...SF_AWS_POINTER_KEYS]) {
    delete next[k];
  }
  if (!next.SF_LOGIN_URL) {
    next.SF_LOGIN_URL = 'https://login.salesforce.com';
  }
  harness.environmentVariables = next;
  fs.writeFileSync(harnessPath, `${JSON.stringify(harness, null, 2)}\n`);
  fs.writeFileSync(harnessEnvFilePath, '{}\n');
  console.log(`Stripped Salesforce secrets from ${harnessPath} (kept SF_LOGIN_URL default if absent).`);
  console.log(`Reset ${harnessEnvFilePath} to {} — re-run merge (without --clear) before the next image deploy.`);
}

function merge() {
  if (!envPath) {
    console.error(
      `No .env.harness found. Tried:\n  ${envCandidates.join('\n  ')}\n` +
        'Copy .env.harness.sample to .env.harness (repo or AgentCore project root), set SF_*, then re-run.',
    );
    process.exit(1);
  }

  const raw = fs.readFileSync(envPath, 'utf8');
  /** @type {Record<string, string>} */
  const parsed = { ...parse(raw) };

  resolvePrivateKeyFile(envPath, parsed);
  expandUnquotedMultilinePrivateKey(raw, parsed);

  if (parsed.SF_PRIVATE_KEY) {
    parsed.SF_PRIVATE_KEY = stripSurroundingQuotes(parsed.SF_PRIVATE_KEY);
  }
  assertPrivateKeyUsable(parsed.SF_PRIVATE_KEY);

  const harness = JSON.parse(fs.readFileSync(harnessPath, 'utf8'));
  const envVars = { ...(harness.environmentVariables || {}) };

  for (const k of SF_ALL_KEYS) {
    if (k === 'SF_PRIVATE_KEY_FILE') continue;
    const v = parsed[k];
    if (v !== undefined && v !== '') {
      envVars[k] = v;
    }
  }
  if (!envVars.SF_LOGIN_URL) {
    envVars.SF_LOGIN_URL = 'https://login.salesforce.com';
  }

  const hasAwsPointer =
    Boolean(String(envVars.SF_SECRET_ID || '').trim()) || Boolean(String(envVars.SF_SSM_PARAMETER_NAME || '').trim());
  const hasKeyMaterial = Boolean(envVars.SF_PRIVATE_KEY || envVars.SF_PRIVATE_KEY_BODY);

  if (!hasAwsPointer) {
    const missing = [];
    if (!envVars.SF_CLIENT_ID) missing.push('SF_CLIENT_ID');
    if (!envVars.SF_USERNAME) missing.push('SF_USERNAME');
    if (!hasKeyMaterial) missing.push('SF_PRIVATE_KEY or SF_PRIVATE_KEY_BODY');
    if (missing.length) {
      console.error(`After merge from ${envPath}, still missing: ${missing.join(', ')}`);
      process.exit(1);
    }
  } else {
    console.warn(
      'AWS credential pointers set (SF_SECRET_ID / SF_SSM_PARAMETER_NAME). JWT fields may load at runtime from Secrets Manager / SSM — ensure IAM on the harness execution role allows GetSecretValue / GetParameter.',
    );
  }

  for (const [k, v] of Object.entries(envVars)) {
    assertEnvValueLength(k, v);
  }

  harness.environmentVariables = envVars;
  fs.writeFileSync(harnessPath, `${JSON.stringify(harness, null, 2)}\n`);

  /** Keep in sync with `HARNESS_SALESFORCE_ENV_FILE_KEYS` in `scripts/sf-query.js`. */
  const fileKeys = [
    'SF_LOGIN_URL',
    'SF_CLIENT_ID',
    'SF_USERNAME',
    'SF_PRIVATE_KEY',
    'SF_PRIVATE_KEY_BODY',
    'SF_QUERY_DEBUG',
    ...SF_AWS_POINTER_KEYS,
  ];
  /** @type {Record<string, string>} */
  const filePayload = {};
  for (const k of fileKeys) {
    const v = envVars[k];
    if (v !== undefined && v !== null && String(v).length > 0) filePayload[k] = String(v);
  }
  fs.writeFileSync(harnessEnvFilePath, `${JSON.stringify(filePayload)}\n`);
  console.log(`Merged Salesforce env from ${envPath} into ${harnessPath}`);
  console.log(
    `Wrote ${harnessEnvFilePath} — copied into the harness image (sf-query reads it when AgentCore does not inject SF_* into tool processes).`,
  );
  console.warn(
    'harness.json and .harness-salesforce-env.json may contain secrets — do not commit. After a successful deploy, run: npm run merge-harness-env -- --clear',
  );
}

if (!fs.existsSync(specPath)) {
  console.error(`Missing ${specPath}`);
  process.exit(1);
}
if (!fs.existsSync(harnessPath)) {
  console.error(`Missing ${harnessPath}`);
  process.exit(1);
}

if (clearOnly) {
  clear();
} else {
  merge();
}

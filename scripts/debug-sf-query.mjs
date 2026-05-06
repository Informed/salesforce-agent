#!/usr/bin/env node
/**
 * Run scripts/sf-query.js with the same environmentVariables as the AgentCore harness
 * (from merged harness.json), with SF_QUERY_DEBUG=1 — reproduces harness behavior locally.
 *
 * Usage (repo root):
 *   npm run debug-sf-query
 *   npm run debug-sf-query -- "SELECT Id FROM User LIMIT 1"
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const agentCoreRoot = path.resolve(repoRoot, 'salesforceAgent00');
const specPath = path.join(agentCoreRoot, 'agentcore', 'agentcore.json');

function harnessJsonPath() {
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const h = spec.harnesses?.[0];
  if (!h?.path) throw new Error(`Missing harnesses[0].path in ${specPath}`);
  return path.join(agentCoreRoot, h.path, 'harness.json');
}

const harnessPath = harnessJsonPath();
const argvSoql = process.argv.slice(2).join(' ').trim();
const soql = argvSoql || 'SELECT Id FROM User LIMIT 1';
const harness = JSON.parse(fs.readFileSync(harnessPath, 'utf8'));
const envVars = harness.environmentVariables || {};

console.error(`[debug-sf-query] harness.json: ${harnessPath}`);
console.error(`[debug-sf-query] SOQL: ${soql.slice(0, 120)}${soql.length > 120 ? '…' : ''}`);
console.error('[debug-sf-query] SF_QUERY_DEBUG=1 for this run. JSON result on stdout; [sf-query] lines on stderr.\n');

const r = spawnSync(process.execPath, ['scripts/sf-query.js', soql], {
  cwd: repoRoot,
  env: { ...process.env, ...envVars, SF_QUERY_DEBUG: '1' },
  stdio: 'inherit',
});

process.exit(r.status === null ? 1 : r.status);

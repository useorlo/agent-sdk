#!/usr/bin/env node
/** Install an explicit published version in a Claude Code project. No credentials are saved. */
import { parseArgs } from 'node:util';
import { OrloAgentClient } from './index.js';
import { installSkill } from './skill-installer.js';

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    skill: { type: 'string' }, version: { type: 'string' }, project: { type: 'string' }, replace: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    process.stdout.write('orlo-skills install --skill <skill-id> --version <version-id> --project <directory> [--replace]\nSet ORLO_API_URL, ORLO_ORG_ID, and ORLO_API_KEY (skills.read). Installs a project skill for Claude Code.\n'); return;
  }
  if (positionals.length !== 1 || positionals[0] !== 'install' || !values.skill || !values.version || !values.project) throw new Error('Use: orlo-skills install --skill <skill-id> --version <version-id> --project <directory> [--replace]');
  const { ORLO_API_URL: baseUrl, ORLO_ORG_ID: orgId, ORLO_API_KEY: key } = process.env;
  if (!baseUrl || !orgId || !key) throw new Error('Set ORLO_API_URL, ORLO_ORG_ID, and ORLO_API_KEY. The key needs skills.read.');
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('ORLO_API_URL must use HTTPS, or HTTP on localhost, without credentials or query parameters.');
  const client = new OrloAgentClient({ baseUrl, orgId, headers: { Authorization: `Bearer ${key}` }, timeoutMs: 15_000,
    fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }) });
  const version = await client.getSkillVersion(values.skill, values.version);
  const result = await installSkill({ project: values.project, orgId, version, replace: values.replace });
  process.stdout.write(`${result.changed ? 'Installed' : 'Already installed'} ${version.name} v${version.version} at ${result.path}\nVersion ${result.versionId}; SHA-256 ${version.content_hash}\nInvoke /${version.name} in Claude Code. Tool permissions remain with the host; installation does not report executions to Orlo.\n`);
}

if (require.main === module) main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : 'Installation failed.'}\n`); process.exitCode = 1; });

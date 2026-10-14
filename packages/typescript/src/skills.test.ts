import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serializeSkillContent } from './skill-content.js';
import { type SkillVersion } from './protocol.js';
import { OrloAgentClient, OrloAgentRun, OrloGovernanceBlockedError, createGenericRuntimeAdapter, installSkill, verifySkillVersion } from './index.js';
import { main } from './skills-cli.js';

const orgId = randomUUID();
const sign = (skill: SkillVersion): SkillVersion => ({ ...skill, content_hash: createHash('sha256').update(serializeSkillContent(skill.name, skill)).digest('hex') });
const version = (previous?: SkillVersion): SkillVersion => sign({
  id: randomUUID(), skill_id: previous?.skill_id ?? randomUUID(), name: 'support-triage', version: (previous?.version ?? 0) + 1,
  description: 'Use to triage a support ticket.', instructions: 'Classify the ticket. Request approval before changing a customer account.',
  compatibility: '', files: [{ path: 'references/priority.md', content: 'Outages are urgent.' }, { path: 'scripts/check.sh', content: 'echo SHOULD_NOT_RUN' }, { path: 'LICENSE.txt', content: 'Original license.' }],
  content_hash: '', created_by: 'user:author', created_at: new Date().toISOString(), published_by: 'user:publisher', published_at: new Date().toISOString(),
});
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const directories: string[] = [];
const project = async () => { const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orlo-skills-test-'))); directories.push(dir); return dir; };
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

describe('pinned project skill installation', () => {
  it('installs a portable Claude Code skill, updates only explicitly, and retains earlier versions for rollback', async () => {
    const root = await project(); const first = version();
    const input = { project: root, orgId, version: first };
    const installed = await installSkill(input);
    expect(installed.changed).toBe(true);
    expect(installed.path).toBe(path.join(root, '.claude/skills/support-triage'));
    expect((await fs.lstat(installed.path)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(installed.path, 'SKILL.md'), 'utf8')).toContain(`orlo-version-id: "${first.id}"`);
    expect(await fs.readFile(path.join(installed.path, 'references/priority.md'), 'utf8')).toBe('Outages are urgent.');
    expect(await fs.readFile(path.join(installed.path, 'LICENSE.txt'), 'utf8')).toBe('Original license.');
    expect((await fs.stat(path.join(installed.path, 'scripts/check.sh'))).mode & 0o111).toBe(0);
    expect(JSON.parse(await fs.readFile(path.join(installed.path, '.orlo-version.json'), 'utf8'))).toMatchObject({ org_id: orgId, version_id: first.id, content_hash: first.content_hash });
    expect((await installSkill(input)).changed).toBe(false);
    const originalPath = await fs.realpath(installed.path); const second = version(first);
    await expect(installSkill({ ...input, version: second })).rejects.toThrow('--replace');
    await installSkill({ ...input, version: second, replace: true });
    expect(await fs.realpath(installed.path)).not.toBe(originalPath);
    expect(await fs.readFile(path.join(originalPath, 'SKILL.md'), 'utf8')).toContain(first.id);
    await installSkill({ ...input, replace: true });
    expect(await fs.realpath(installed.path)).toBe(originalPath);
    await fs.writeFile(path.join(installed.path, 'SKILL.md'), 'local edits');
    await expect(installSkill(input)).rejects.toThrow('local edits');
    expect(await fs.readFile(path.join(installed.path, 'SKILL.md'), 'utf8')).toBe('local edits');
  });

  it('preserves existing local skills and refuses unowned links or symlinked parent directories', async () => {
    const root = await project(); const first = version(); const target = path.join(root, '.claude/skills', first.name);
    await fs.mkdir(target, { recursive: true }); await fs.writeFile(path.join(target, 'SKILL.md'), 'mine');
    await expect(installSkill({ project: root, orgId, version: first, replace: true })).rejects.toThrow('local skill');
    expect(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8')).toBe('mine');
    await fs.rm(target, { recursive: true });
    const outside = await project(); await fs.symlink(outside, target, 'dir');
    await expect(installSkill({ project: root, orgId, version: first, replace: true })).rejects.toThrow('not managed');
    const otherRoot = await project(); await fs.symlink(outside, path.join(otherRoot, '.claude'), 'dir');
    await expect(installSkill({ project: otherRoot, orgId, version: first })).rejects.toThrow('symlink');
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('refuses tampered, unpublished, unsafe, or unexpected content before installation', async () => {
    const root = await project(); const first = version();
    const unsafe = sign({ ...first, files: [{ path: 'references/../../outside', content: 'bad' }] });
    for (const invalid of [unsafe, { ...first, instructions: 'Tampered' }, { ...first, published_at: null }]) {
      await expect(installSkill({ project: root, orgId, version: invalid })).rejects.toThrow('requested, published version');
    }
    expect(await fs.readdir(root)).toEqual([]);
    expect(() => verifySkillVersion(first, first.skill_id, randomUUID())).toThrow();
  });

  it('runs the CLI using scoped credentials without writing them into the installed package', async () => {
    const root = await project(); const first = version(); const key = 'test-private-key-not-for-files';
    vi.stubEnv('ORLO_API_URL', 'https://orlo.test'); vi.stubEnv('ORLO_ORG_ID', orgId); vi.stubEnv('ORLO_API_KEY', key);
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => { expect(init?.redirect).toBe('error'); expect(init?.headers).toMatchObject({ Authorization: `Bearer ${key}` }); return json(first); });
    vi.stubGlobal('fetch', fetchMock);
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await main(['install', '--skill', first.skill_id, '--version', first.id, '--project', root]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toBe(`https://orlo.test/v1/skills/${first.skill_id}/versions/${first.id}`);
    expect(output.mock.calls.flat().join('')).not.toContain(key);
    expect(await fs.readFile(path.join(root, '.claude/skills', first.name, '.orlo-version.json'), 'utf8')).not.toContain(key);
    vi.stubEnv('ORLO_API_URL', 'http://remote.example.com');
    await expect(main(['install', '--skill', first.skill_id, '--version', first.id, '--project', root])).rejects.toThrow('HTTPS');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('application agent skill consumption', () => {
  it('verifies content, records exact versions, and still refuses a tool that permission checks reject', async () => {
    const first = version(); const requests: Array<{ url: string; body: any }> = [];
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null; requests.push({ url: String(url), body });
      if (String(url).includes('/skills/')) return json(first);
      if (String(url).endsWith('/agent-sessions')) return json({ session: { id: 'run-1', skill_versions: body.skill_versions }, policy_cache_ttl_s: 60 });
      return json({ decision: 'reject', reason: 'This tool is not permitted.', trace_id: 'trace-1', risk_tier: 'medium', containment: null });
    });
    const client = new OrloAgentClient({ baseUrl: 'https://orlo.test', orgId, fetch: fetchMock as typeof fetch });
    const loaded = await OrloAgentRun.startWithSkills(client, { task_id: randomUUID() }, [{ skillId: first.skill_id, versionId: first.id }]);
    expect(requests[1].body.skill_versions).toEqual([{ skill_id: first.skill_id, version_id: first.id, content_hash: first.content_hash }]);
    expect(loaded.instructions).toContain('Outages are urgent.');
    expect(loaded.instructions).not.toContain('SHOULD_NOT_RUN');
    expect(loaded.skills[0].id).toBe(first.id);
    const execute = vi.fn(async () => 'changed');
    await expect(createGenericRuntimeAdapter({ run: loaded.run }).runToolStep({ stepId: 'write', toolName: 'change_account', arguments: {}, actionClass: 'write', execute })).rejects.toBeInstanceOf(OrloGovernanceBlockedError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses altered content before creating a session and cancels a session on an older server without attribution', async () => {
    const first = version();
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ ...first, instructions: 'Altered' }));
    const client = new OrloAgentClient({ baseUrl: 'https://orlo.test', orgId, fetch: fetchMock as typeof fetch });
    const start = () => OrloAgentRun.startWithSkills(client, { task_id: randomUUID() }, [{ skillId: first.skill_id, versionId: first.id }]);
    await expect(start()).rejects.toThrow('matching content'); expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockResolvedValueOnce(json(first)).mockResolvedValueOnce(json({ session: { id: 'old-server-run' }, policy_cache_ttl_s: 60 })).mockResolvedValueOnce(json({ id: 'old-server-run', status: 'cancelled' }));
    await expect(start()).rejects.toThrow('did not record');
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('https://orlo.test/v1/agent-sessions/old-server-run');
    expect(JSON.parse(fetchMock.mock.calls.at(-1)?.[1].body)).toEqual({ status: 'cancelled' });
  });
});

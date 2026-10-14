/** Project-scoped Claude Code integration. Content stays versioned; only an Orlo-owned symlink changes. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { skillPackage } from './skill-content.js';
import { type SkillVersion } from './protocol.js';
import { verifySkillVersion } from './skills.js';

async function existing(file: string) {
  try { return await fs.lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** Never traverse a symlink supplied by an existing checkout. The project root is chosen by the user. */
async function directories(root: string, relative: string): Promise<string> {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try { await fs.mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`The skill directory contains a symlink or non-directory: ${current}`);
  }
  return current;
}

export async function installSkill(input: { project: string; orgId: string; version: SkillVersion; replace?: boolean }): Promise<{ path: string; versionId: string; changed: boolean }> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(input.orgId) || !uuid.test(input.version?.id) || !uuid.test(input.version?.skill_id)) throw new Error('The organization, skill, and version must have UUID identifiers.');
  const version = verifySkillVersion(input.version, input.version.skill_id, input.version.id);
  if (['synced', 'anthropic-skills'].includes(version.name)) throw new Error('Claude Code reserves this skill name. Choose another name in Orlo.');
  const root = await fs.realpath(input.project);
  const cacheBase = await directories(root, `.orlo/skills/${input.orgId}/${version.skill_id}`);
  const links = await directories(root, '.claude/skills');
  const locks = await directories(root, '.orlo/skill-locks');
  const lock = path.join(locks, version.name);
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another install of this skill is in progress. Retry when it finishes.'); throw error; }
  let staging: string | null = null; let pendingLink: string | null = null;
  try {
    const target = path.join(links, version.name);
    const storedVersion = path.join(cacheBase, version.id);
    const storedSkill = path.join(storedVersion, version.name);
    const installed = await existing(target);
    if (installed) {
      if (!installed.isSymbolicLink()) throw new Error('A local skill already occupies this name. It was not changed. Rename it or choose another skill name.');
      const previous = path.resolve(links, await fs.readlink(target));
      const relative = path.relative(cacheBase, previous).split(path.sep);
      if (relative.length !== 2 || !uuid.test(relative[0]) || relative[1] !== version.name) throw new Error('This skill link is not managed by this Orlo organization and skill. It was not changed.');
      if (previous !== storedSkill && !input.replace) throw new Error('A different version is installed. Pass --replace to select this version; the previous files will be retained.');
    }
    const bundle = skillPackage(version);
    const manifest = JSON.stringify({ org_id: input.orgId, skill_id: version.skill_id, version_id: version.id, content_hash: version.content_hash, name: version.name, version: version.version }, null, 2);
    if (await existing(storedVersion)) {
      await directories(root, `.orlo/skills/${input.orgId}/${version.skill_id}/${version.id}/${version.name}`);
      const files = [...bundle.files, { path: '.orlo-version.json', content: manifest }];
      const expected = new Set(files.map((file) => file.path));
      const inspect = async (relative = ''): Promise<void> => {
        for (const entry of await fs.readdir(path.join(storedSkill, relative), { withFileTypes: true })) {
          const name = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.isSymbolicLink()) throw new Error('The saved version contains a symlink and was not used.');
          if (entry.isDirectory()) await inspect(name);
          else if (!entry.isFile()) throw new Error('The saved version contains a non-regular file and was not used.');
          else if (!expected.has(name)) throw new Error('The saved version has local additions and was not changed.');
        }
      };
      await inspect();
      for (const file of files) {
        const filename = path.join(storedSkill, file.path);
        if ((await existing(filename))?.isSymbolicLink() || await fs.readFile(filename, 'utf8') !== file.content) throw new Error('The saved version has local edits and was not changed.');
      }
    } else {
      staging = await fs.mkdtemp(path.join(cacheBase, '.install-'));
      const skillRoot = await directories(staging, version.name);
      for (const file of [...bundle.files, { path: '.orlo-version.json', content: manifest }]) {
        if (file.path.includes('/')) await directories(skillRoot, path.posix.dirname(file.path));
        await fs.writeFile(path.join(skillRoot, file.path), file.content, { flag: 'wx', mode: 0o600 });
      }
      await fs.rename(staging, storedVersion); staging = null;
    }
    if (installed && path.resolve(links, await fs.readlink(target)) === storedSkill) return { path: target, versionId: version.id, changed: false };
    pendingLink = path.join(links, `.orlo-${randomUUID()}`);
    await fs.symlink(path.relative(links, storedSkill), pendingLink, 'dir');
    await fs.rename(pendingLink, target); pendingLink = null;
    return { path: target, versionId: version.id, changed: true };
  } finally {
    if (staging) await fs.rm(staging, { recursive: true, force: true });
    if (pendingLink) await fs.unlink(pendingLink).catch(() => {});
    await fs.rmdir(lock);
  }
}

/** Verify content before a host uses or installs it. Reading a skill never grants tool permissions. */
import { createHash } from 'node:crypto';
import { serializeSkillContent, validSkillFilePath } from './skill-content.js';
import { type SkillVersion } from './protocol.js';

export function verifySkillVersion(value: unknown, skillId: string, versionId: string): SkillVersion {
  const skill = value as SkillVersion;
  const fail = (): never => { throw new Error('The skill response is not the requested, published version with matching content.'); };
  if (!skill || skill.id !== versionId || skill.skill_id !== skillId || !skill.published_at
    || typeof skill.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) || skill.name.length > 64
    || !Number.isSafeInteger(skill.version) || skill.version < 1
    || typeof skill.description !== 'string' || !skill.description.trim() || skill.description.length > 1024
    || typeof skill.instructions !== 'string' || !skill.instructions.trim() || skill.instructions.length > 65_536
    || typeof skill.compatibility !== 'string' || skill.compatibility.length > 500
    || typeof skill.content_hash !== 'string' || !/^[a-f0-9]{64}$/.test(skill.content_hash)
    || !Array.isArray(skill.files) || skill.files.length > 24) fail();
  const paths = new Set<string>(); let bytes = 0;
  for (const file of skill.files) {
    if (!file || typeof file.path !== 'string' || !validSkillFilePath(file.path) || typeof file.content !== 'string' || file.content.includes('\0') || file.content.length > 65_536) fail();
    if (paths.has(file.path.toLowerCase())) fail(); paths.add(file.path.toLowerCase()); bytes += Buffer.byteLength(file.content);
  }
  const keys = [...paths];
  if (bytes > 262_144 || keys.some((key) => keys.some((other) => other.startsWith(`${key}/`)))) fail();
  if (createHash('sha256').update(serializeSkillContent(skill.name, skill)).digest('hex') !== skill.content_hash) fail();
  return skill;
}

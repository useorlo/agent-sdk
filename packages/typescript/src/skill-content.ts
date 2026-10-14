/** Portable skill formatting and verification. Contains no server queries or execution logic. */
import type { SkillContent, SkillVersion, SkillPackage } from "./protocol.js";

/** Stable content order for server hashes and consumer verification. */
export function serializeSkillContent(name: string, content: SkillContent): string {
  return JSON.stringify({ name, description: content.description, instructions: content.instructions, compatibility: content.compatibility,
    files: [...content.files].map(({ path, content }) => ({ path, content })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) });
}

export function validSkillFilePath(path: string): boolean {
  return path.length <= 180 && (/^(references|scripts|assets)\/[a-zA-Z0-9_./-]+$/.test(path)
    || /^(LICENSE|NOTICE|README)(\.(md|txt))?$/i.test(path))
    && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !part.endsWith('.')
      && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part));
}

/** Missing fields remain visible. Only own input fields may substitute variables. */
export function renderPromptTemplate(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(Object.hasOwn(input, key) ? input[key] ?? `{{${key}}}` : `{{${key}}}`));
}

export function taskSystemInstructions(task: { prompt_template?: unknown; description?: unknown; skills?: SkillVersion[] }, input: Record<string, unknown>): string {
  const own = typeof task.prompt_template === 'string' && task.prompt_template
    ? renderPromptTemplate(task.prompt_template, input)
    : typeof task.description === 'string' && task.description || 'You are a helpful assistant.';
  const shared = (task.skills ?? []).map((skill) => {
    // Task inference has no tool executor. Text references are available to the model; scripts are
    // distributed to agent hosts but never run or pasted into a task's prompt as instructions.
    const references = skill.files.filter((file) => !file.path.startsWith('scripts/'))
      .map((file) => `Reference file: ${file.path}\n${file.content}`).join('\n\n');
    return `Shared skill: ${skill.name} (version ${skill.version})\n${skill.instructions}${references ? `\n\n${references}` : ''}`;
  });
  return [...shared, own].join('\n\n');
}

/** Agent Skills frontmatter uses JSON-quoted strings, which are also valid YAML scalars. */
export function skillPackage(version: SkillVersion): SkillPackage {
  const header = ['---', `name: ${version.name}`, `description: ${JSON.stringify(version.description)}`,
    ...(version.compatibility ? [`compatibility: ${JSON.stringify(version.compatibility)}`] : []),
    'metadata:', `  orlo-skill-id: ${JSON.stringify(version.skill_id)}`, `  orlo-version-id: ${JSON.stringify(version.id)}`,
    `  orlo-version: ${JSON.stringify(String(version.version))}`, `  orlo-content-hash: ${JSON.stringify(version.content_hash)}`, '---'];
  return { skill_id: version.skill_id, version_id: version.id, name: version.name, version: version.version, content_hash: version.content_hash,
    files: [{ path: 'SKILL.md', content: `${header.join('\n')}\n\n${version.instructions}\n` }, ...version.files] };
}

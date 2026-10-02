const isPlugin = (skill: string): boolean => skill.includes(':');
const bareName = (skill: string): string => skill.slice(skill.indexOf(':') + 1).toLowerCase();

/** The text after a leading "/" when the whole draft is still one slash word, otherwise null. */
export function slashQuery(draft: string): string | null {
  const match = /^\/(\S*)$/.exec(draft);
  return match ? (match[1] ?? '') : null;
}

/** Skills containing the query: name starts first, own skills before plugin ones, init order kept inside each group. */
export function matchSkills(skills: string[], query: string): string[] {
  const needle = query.toLowerCase();
  const rank = (skill: string): number => (bareName(skill).startsWith(needle) ? 0 : 2) + (isPlugin(skill) ? 1 : 0);
  return skills
    .filter((skill) => skill.toLowerCase().includes(needle))
    .map((skill, order) => ({ skill, order }))
    .sort((a, b) => rank(a.skill) - rank(b.skill) || a.order - b.order)
    .map(({ skill }) => skill);
}

export const skillCommand = (skill: string): string => `/${skill} `;

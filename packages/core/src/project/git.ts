export const GIT_NOT_FOUND = 'git was not found on this machine.';

// A failed ssh clone ends with advice lines ("and the repository exists."): the reason is the last fatal:/error: line.
export const isGitFailureLine = (line: string): boolean => /^(?:fatal|error):/.test(line);

export function gitErrorMessage(error: unknown, stderr: string): string {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return GIT_NOT_FOUND;
  const lines = stderr.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean);
  return lines.findLast(isGitFailureLine) ?? lines.at(-1) ?? (error as Error).message;
}

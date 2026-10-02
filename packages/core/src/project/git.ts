export const GIT_NOT_FOUND = 'git was not found on this machine.';

export function gitErrorMessage(error: unknown, stderr: string): string {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return GIT_NOT_FOUND;
  const last = stderr.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean).at(-1);
  return last ?? (error as Error).message;
}

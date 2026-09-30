export interface ResumeInput {
  kept: string[];
  reverted: string[];
  added: string[];
  mine: string[];
  conflicts: { path: string; reason: string }[];
  interrupted: boolean;
  killedSubagents: string[];
  backgroundShell: boolean;
  unknownOrigin: boolean;
  failOpen: boolean;
}

const MAX_CHARS = 1_500;
const MAX_NAMES = 8;
const MAX_NAME_CHARS = 150;
const CLOSING = 'Check the current state of the kept files and continue from it rather than redoing them.';

const short = (name: string): string => (name.length > MAX_NAME_CHARS ? `${name.slice(0, MAX_NAME_CHARS - 1)}…` : name);

function list(names: string[]): string {
  const shown = names.slice(0, MAX_NAMES).map(short);
  const more = names.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
}

function cap(sentences: string[]): string {
  const [first = '', ...rest] = sentences;
  let text = first;
  for (const sentence of rest) {
    if (`${text} ${sentence} ${CLOSING}`.length > MAX_CHARS) break;
    text = `${text} ${sentence}`;
  }
  return `${text} ${CLOSING}`.slice(0, MAX_CHARS);
}

export function resumeMessage(i: ResumeInput): string {
  const parts = ['[IDE] The user answered the out-of-plan question.'];
  if (i.kept.length) parts.push(`Kept as you wrote them: ${list(i.kept)}.`);
  if (i.reverted.length) parts.push(`Restored to their earlier content: ${list(i.reverted)}.`);
  if (i.added.length) parts.push(`Added to the approved plan: ${list(i.added)}.`);
  if (i.mine.length) parts.push(`Edited by the user, not by you: ${list(i.mine)}.`);
  if (i.conflicts.length) parts.push(`Not restored: ${list(i.conflicts.map((c) => `${c.path} (${c.reason})`))}.`);
  if (i.interrupted) parts.push('The call that was running was stopped before it finished, so its result may be partial.');
  if (i.killedSubagents.length) parts.push(`Stopped with it: ${list(i.killedSubagents)}; their unfinished work is lost.`);
  if (i.backgroundShell) parts.push('A background shell is still running.');
  if (i.unknownOrigin) parts.push('These files changed while the IDE was not running.');
  if (i.failOpen) parts.push('A safety hook did not run for one call, so its file changes were treated as out of plan.');
  return cap(parts);
}

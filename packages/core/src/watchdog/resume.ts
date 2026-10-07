export interface ResumeInput {
  kept: string[];
  reverted: string[];
  added: string[];
  mine: string[];
  conflicts: { path: string; reason: string }[];
  interrupted: boolean;
  withdrawnPlan: boolean;
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

function list(names: string[], maxNames: number, noun: string): string {
  if (maxNames === 0 && names.length > 1) return `${names.length} ${noun}`;
  const shown = names.slice(0, maxNames).map(short);
  const more = names.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
}

function sentences(i: ResumeInput, maxNames: number): string {
  const parts = ['[CodeRay] The user answered the out-of-plan question.'];
  if (i.kept.length) parts.push(`Kept as you wrote them: ${list(i.kept, maxNames, 'files')}.`);
  if (i.reverted.length) parts.push(`Restored to their earlier content: ${list(i.reverted, maxNames, 'files')}.`);
  if (i.added.length) parts.push(`Added to the approved plan: ${list(i.added, maxNames, 'files')}.`);
  if (i.mine.length) parts.push(`Edited by the user, not by you: ${list(i.mine, maxNames, 'files')}.`);
  if (i.conflicts.length) parts.push(`Not restored: ${list(i.conflicts.map((c) => `${c.path} (${c.reason})`), maxNames, 'files')}.`);
  if (i.interrupted) parts.push('The call that was running was stopped before it finished, so its result may be partial.');
  if (i.withdrawnPlan) parts.push('The plan you proposed was still waiting for the user; the interrupt withdrew it, so propose it again if it is still needed.');
  if (i.killedSubagents.length) parts.push(`Stopped with it: ${list(i.killedSubagents, maxNames, 'subagents')}; their unfinished work is lost.`);
  if (i.backgroundShell) parts.push('A background shell is still running.');
  if (i.unknownOrigin) parts.push('These files changed while CodeRay was not running.');
  if (i.failOpen) parts.push('A safety hook did not run for one call, so its file changes were treated as out of plan.');
  parts.push(CLOSING);
  return parts.join(' ');
}

export function resumeMessage(i: ResumeInput): string {
  for (let maxNames = MAX_NAMES; maxNames > 0; maxNames -= 1) {
    const text = sentences(i, maxNames);
    if (text.length <= MAX_CHARS) return text;
  }
  return sentences(i, 0).slice(0, MAX_CHARS);
}

export interface RollbackInput {
  stepKey: string;
  restored: string[];
  notRestored: { path: string; reason: string }[];
  stepReset?: boolean;
}

function rollbackSentences(i: RollbackInput, maxNames: number): string {
  const parts = [`[CodeRay] Step "${short(i.stepKey)}" was rolled back by the user.`];
  if (i.restored.length) parts.push(`Restored: ${list(i.restored, maxNames, 'files')}.`);
  if (i.notRestored.length) parts.push(`Not restored: ${list(i.notRestored.map((f) => `${f.path} (${f.reason})`), maxNames, 'files')}.`);
  parts.push(i.stepReset === false
    ? 'The step was not reset because the agent became busy; it is still marked as it was.'
    : 'The step is pending again; start it with the step tool before changing files for it.');
  return parts.join(' ');
}

export function rollbackMessage(i: RollbackInput): string {
  for (let maxNames = MAX_NAMES; maxNames > 0; maxNames -= 1) {
    const text = rollbackSentences(i, maxNames);
    if (text.length <= MAX_CHARS) return text;
  }
  return rollbackSentences(i, 0).slice(0, MAX_CHARS);
}

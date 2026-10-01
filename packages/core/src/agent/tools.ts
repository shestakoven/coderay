export const DISALLOWED_TOOLS = [
  'SendMessage', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger',
  'Workflow', 'EnterWorktree', 'ExitWorktree', 'DesignSync', 'PushNotification',
];

export const MIN_CLAUDE_VERSION = '2.1.281';

// The value becomes an argv entry for claude, so it must never start with '-' or carry anything but a model alias or id.
const MODEL_CHOICE = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,63}$/;

export const isModelChoice = (value: string): boolean => MODEL_CHOICE.test(value);

const SUMMARY_FIELDS = ['command', 'file_path', 'notebook_path', 'description', 'pattern', 'url', 'query', 'prompt'];
const MAX_SUMMARY = 200;

export function summarizeToolInput(input: unknown, root: string): string {
  const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const field = SUMMARY_FIELDS.find((key) => typeof record[key] === 'string');
  const raw = field ? String(record[field]) : (JSON.stringify(input) ?? '');
  const relative = raw.startsWith(`${root}/`) ? raw.slice(root.length + 1) : raw;
  const summary = `${record.run_in_background === true ? '& ' : ''}${relative.split('\n')[0] ?? ''}`;
  return summary.length > MAX_SUMMARY ? `${summary.slice(0, MAX_SUMMARY - 1)}…` : summary;
}

export function isOlderVersion(version: string, minimum: string): boolean {
  const parts = (value: string) => value.split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const [have, need] = [parts(version), parts(minimum)];
  for (let index = 0; index < 3; index += 1) {
    const a = have[index] ?? 0;
    const b = need[index] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}

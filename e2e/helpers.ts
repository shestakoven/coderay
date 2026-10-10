import { existsSync, readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

export async function sendMessage(page: Page, text: string): Promise<void> {
  await expect(page.getByText('core connected')).toBeVisible();
  // A prompt raised before the first map snapshot has no node to open at.
  await expect(page.getByRole('tree').getByRole('treeitem').first()).toBeVisible();
  await page.getByPlaceholder(/Message the agent/).fill(text);
  await page.keyboard.press('Enter');
}

export interface AgentLaunch {
  argv: string[];
  pid: number;
}

const recorded = (record: string): { argv?: string[]; pid?: number; interactive?: boolean }[] =>
  existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];

// The interactive claudes the core has started, oldest first: the fake records one line per process, and only the agent terminal starts it without -p.
export function terminalLaunches(record: string): AgentLaunch[] {
  return recorded(record).flatMap((entry) => (entry.interactive && entry.argv && entry.pid ? [{ argv: entry.argv, pid: entry.pid }] : []));
}

// How many times the core has checked that CodeRay's hook runs: the check is the one headless claude that keeps no session.
export const hookChecks = (record: string): number => recorded(record).filter((entry) => entry.argv?.includes('--no-session-persistence')).length;

// The conversation the chat's own headless claude was started on.
export function chatConversation(record: string): string | undefined {
  const chat = recorded(record).find((entry) => !entry.interactive && entry.argv && hasFlag(entry.argv, '--session-id'));
  return chat?.argv ? flagOf(chat.argv, '--session-id') : undefined;
}

export const hasFlag = (argv: string[], name: string): boolean => argv.some((arg) => arg === name || arg.startsWith(`${name}=`));

// A flag's value in either form: `--name value` or `--name=value`.
export function flagOf(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  if (at !== -1) return argv[at + 1];
  return argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

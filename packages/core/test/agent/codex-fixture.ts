import { readFileSync } from 'node:fs';
import { fixture } from '../helpers';

export type RawHook = Record<string, unknown> & { hook_event_name: string };

// A real Codex CLI 0.160 session, one raw hook payload per line: a shell call, a subagent that runs a shell call,
// waiting for it and closing it, the end of the turn, then a second prompt stopped with Esc.
export const codexHooks = (): RawHook[] =>
  readFileSync(fixture('codex-hooks.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as RawHook);

export const CODEX_SESSION = '01a10c6c-80f9-7792-b92d-d28cb3b9cc74';
export const SUBAGENT = '01a10c6c-c9c8-7f10-b22c-5517cdf9b9a4';
export const CALL = {
  bash: 'call_cn6sNeJpHAZcqW8PfmGdtq5B',
  spawn: 'call_h0bbJ9g6e9XFwxIMSscl5Vh8',
  wait: 'call_WwsCOkDv77hwW07y2b3ISZTC',
  subBash: 'call_AQI4NZy2eh9egkuBTWoSlMPg',
  close: 'call_lFo4OIaW2uVpjrNVb6Lnw2zP',
} as const;

// Where each recorded event sits in the session.
export const AT = {
  sessionStart: 0, prompt: 1, bashStart: 2, bashEnd: 3, spawnStart: 4, spawnEnd: 5, subagentStart: 6, subagentPrompt: 7, waitStart: 8,
  subBashStart: 9, subBashEnd: 10, subagentStop: 11, waitEnd: 12, closeStart: 13, closeEnd: 14, stop: 15, secondPrompt: 16, interrupt: 17, sessionEnd: 18,
} as const;

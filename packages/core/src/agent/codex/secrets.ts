// A key, OpenAI's masked form of one, a JWT or a bearer token in codex's words: none reaches a chat, the sign-in view or a log.
const SECRET = /\b(?:sk-[A-Za-z0-9_-]*\*{3,}[A-Za-z0-9_-]*|sk-[A-Za-z0-9_-]{20,}|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,})|\bBearer\s+[\w.~+/-]+=*/g;

export const hideSecrets = (text: string): string => text.replace(SECRET, '[key hidden]');

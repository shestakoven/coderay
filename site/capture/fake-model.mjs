// Stands for the background model (`claude -p --json-schema …`) the core asks for change summaries.
// It answers the summary prompts of history/summarizer.ts from the table below and fails every other request,
// as the e2e stand-in does, so no grouping or overview pass ever reaches a real model.
import { readFileSync } from 'node:fs';

const STEPS = {
  'Make the limit configurable': 'Added signup_rate_limit (5) and signup_rate_window_s (60) to Settings, so the limit comes from ACME_* variables.',
  'Add a sliding-window rate limiter': 'Created SlidingWindowLimiter, which keeps each IP\'s recent hits and raises RateLimited with a retry delay, plus tests for the window and the 429.',
  'Record blocked attempts': 'Created AuditLog, which writes one JSON line per blocked sign-up with the client IP and the retry delay.',
  'Check the limit before creating a user': 'UserService checks the limiter before anything else and records blocked attempts; POST /users turns RateLimited into 429 with Retry-After.',
};

const COMPONENTS = {
  Config: 'Two new settings for the sign-up limit.',
  'Rate limiting': 'New sliding-window limiter keyed by client IP.',
  'Audit log': 'New audit log for blocked sign-ups.',
  'User service': 'Registration now passes the rate limiter first.',
  'Users API': 'POST /users answers 429 with Retry-After.',
  Email: 'The SMTP timeout now comes from Settings.',
  Tests: 'New tests for the limiter and the 429 response.',
};

const prompt = readFileSync(0, 'utf8');
const facts = (() => {
  try {
    return JSON.parse(prompt.split('\n')[1] ?? '');
  } catch {
    return null;
  }
})();
const summary = facts?.scope === 'step' ? STEPS[facts.title] : facts?.scope === 'component' ? COMPONENTS[facts.name] : undefined;
if (!prompt.startsWith('Describe in one sentence') || summary === undefined) process.exit(1);
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: { summary } }));
}, 600);

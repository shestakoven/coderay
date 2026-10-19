// Builds scenarios/rate-limit.jsonl: the scripted agent of the demo, replayed by packages/core/test/fake-claude/fake-claude.mjs.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCENARIO = join(HERE, 'scenarios/rate-limit.jsonl');

export const PROMPT = 'Add rate limiting to sign-ups: 5 per minute per IP, answer 429';

const lines = [];
const add = (line) => lines.push(line);
const say = (text) => add({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: '$SESSION' });
const sleep = (ms) => add({ fake: 'sleep', ms });
const mcp = (id, tool, input) => add({ fake: 'mcp', id, tool, input });
const read = (id, path, result) => add({ fake: 'tool', id, name: 'Read', input: { file_path: `$CWD/${path}` }, result });
const write = (id, path, content) => add({ fake: 'tool', id, name: 'Write', input: { file_path: `$CWD/${path}`, content }, result: `File created successfully at: ${path}`, apply: true });
const edit = (id, path, oldString, newString) =>
  add({ fake: 'tool', id, name: 'Edit', input: { file_path: `$CWD/${path}`, old_string: oldString, new_string: newString }, result: `The file ${path} has been updated.`, apply: true });
const step = (id, key, phase) => mcp(id, 'step', { key, phase });
const init = () => add({ type: 'system', subtype: 'init', cwd: '$CWD', session_id: '$SESSION', mcp_servers: [{ name: 'idecore', status: 'connected' }], model: 'claude-opus-5-5', permissionMode: 'bypassPermissions', claude_code_version: '2.1.296' });
const result = (text) => add({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: '$SESSION' });

// The plan. Node ids stay the same in v1 and v2, so the map keeps its places between versions.
const STEP = {
  config: { key: 'config', title: 'Make the limit configurable', rationale: '5 sign-ups per 60 s by default; ops can tune it per environment without a deploy.', targets: [{ path: 'app/core/config.py', op: 'modify' }] },
  limiter: {
    key: 'limiter',
    title: 'Add a sliding-window rate limiter',
    rationale: 'Counts attempts per client IP in memory, thread-safe and small enough to swap for Redis later.',
    targets: [{ path: 'app/core/rate_limit.py', op: 'create' }, { path: 'tests/test_rate_limit.py', op: 'create' }],
  },
  audit: { key: 'audit', title: 'Record blocked attempts', rationale: 'Security can see who hits the limit: one structured line per blocked sign-up.', targets: [{ path: 'app/services/audit_log.py', op: 'create' }] },
  wireV1: {
    key: 'wire',
    title: 'Check the limit before creating a user',
    rationale: 'UserService refuses the 6th attempt in a window before any work is done; the route answers 429.',
    targets: [{ path: 'app/services/user_service.py', op: 'modify' }, { path: 'app/routes/users.py', op: 'modify' }],
  },
  wireV2: {
    key: 'wire',
    title: 'Check the limit before creating a user',
    rationale: 'UserService refuses the 6th attempt and records it; the route answers 429 with Retry-After.',
    targets: [{ path: 'app/services/user_service.py', op: 'modify' }, { path: 'app/routes/users.py', op: 'modify' }],
  },
};

const node = {
  client: { id: 'client', title: 'Client', sub: 'Browser · mobile app', kind: 'actor', state: 'existing' },
  route: (note) => ({ id: 'users-route', title: 'POST /users', sub: 'Endpoint · app/routes/users.py', kind: 'endpoint', state: 'modify', steps: ['wire'], files: [{ op: '~', path: 'app/routes/users.py', note }] }),
  service: (note) => ({ id: 'user-service', title: 'UserService', sub: 'Service · app/services/user_service.py', kind: 'service', state: 'modify', steps: ['wire'], files: [{ op: '~', path: 'app/services/user_service.py', note }] }),
  repo: { id: 'user-repo', title: 'UserRepository', sub: 'Store · users table', kind: 'store', state: 'existing' },
  limiter: {
    id: 'rate-limiter',
    title: 'RateLimiter',
    sub: 'Module · app/core/rate_limit.py',
    kind: 'module',
    state: 'create',
    steps: ['limiter'],
    files: [{ op: '+', path: 'app/core/rate_limit.py', note: 'sliding window per client IP' }, { op: '+', path: 'tests/test_rate_limit.py', note: 'limit, window, per-IP, 429' }],
  },
  config: { id: 'config', title: 'Settings', sub: 'Config · app/core/config.py', kind: 'module', state: 'modify', steps: ['config'], files: [{ op: '~', path: 'app/core/config.py', note: 'signup_rate_limit, signup_rate_window_s' }] },
  audit: { id: 'audit-log', title: 'AuditLog', sub: 'Service · app/services/audit_log.py', kind: 'service', state: 'create', steps: ['audit'], files: [{ op: '+', path: 'app/services/audit_log.py', note: 'one JSON line per blocked attempt' }] },
};

const edges = [
  { from: 'client', to: 'users-route', label: 'POST /users', state: 'existing' },
  { from: 'users-route', to: 'user-service', label: 'register(body)', state: 'existing' },
  { from: 'user-service', to: 'user-repo', label: 'add(user)', state: 'existing' },
  { from: 'user-service', to: 'rate-limiter', label: 'hit(client_ip)', state: 'new', step: 'wire' },
  { from: 'rate-limiter', to: 'config', label: 'limit, window', state: 'new', step: 'limiter' },
];

const planV1 = {
  goal: 'Limit sign-ups to 5 per minute per IP and answer 429',
  steps: [STEP.config, STEP.limiter, STEP.wireV1],
  flow: { nodes: [node.client, node.route('answer 429 when limited'), node.service('check the limit before creating'), node.repo, node.limiter, node.config], edges },
};

const planV2 = {
  goal: 'Limit sign-ups to 5 per minute per IP and answer 429',
  steps: [STEP.config, STEP.limiter, STEP.audit, STEP.wireV2],
  flow: {
    nodes: [node.client, node.route('429 with a Retry-After header'), node.service('check the limit, record blocked attempts'), node.repo, node.limiter, node.config, node.audit],
    edges: [...edges, { from: 'user-service', to: 'audit-log', label: 'signup_blocked(ip)', state: 'new', step: 'audit' }],
  },
};

// The code the agent writes.
const RATE_LIMIT = `import math
import time
from collections import defaultdict, deque
from threading import Lock

from app.core.config import settings


class RateLimited(Exception):
    def __init__(self, retry_after: int) -> None:
        super().__init__(f"rate limited, retry after {retry_after}s")
        self.retry_after = retry_after


class SlidingWindowLimiter:
    """Allows \`limit\` hits per key in any \`window_s\`-second window."""

    def __init__(self, limit: int, window_s: int, clock=time.monotonic) -> None:
        self.limit = limit
        self.window_s = window_s
        self.clock = clock
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def hit(self, key: str) -> None:
        now = self.clock()
        with self._lock:
            hits = self._hits[key]
            while hits and now - hits[0] >= self.window_s:
                hits.popleft()
            if len(hits) >= self.limit:
                raise RateLimited(retry_after=max(1, math.ceil(self.window_s - (now - hits[0]))))
            hits.append(now)

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


signup_limiter = SlidingWindowLimiter(settings.signup_rate_limit, settings.signup_rate_window_s)
`;

const RATE_LIMIT_TEST = `import pytest

from app.core.rate_limit import RateLimited, SlidingWindowLimiter, signup_limiter

SIGNUP = {"name": "Ada Lovelace", "password": "analytical-engine"}


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def test_allows_the_limit_then_blocks():
    limiter = SlidingWindowLimiter(limit=5, window_s=60, clock=FakeClock())
    for _ in range(5):
        limiter.hit("10.0.0.1")
    with pytest.raises(RateLimited) as blocked:
        limiter.hit("10.0.0.1")
    assert blocked.value.retry_after == 60


def test_the_window_slides():
    clock = FakeClock()
    limiter = SlidingWindowLimiter(limit=5, window_s=60, clock=clock)
    for _ in range(5):
        limiter.hit("10.0.0.1")
    clock.now = 60.0
    limiter.hit("10.0.0.1")


def test_limits_are_per_ip():
    limiter = SlidingWindowLimiter(limit=1, window_s=60, clock=FakeClock())
    limiter.hit("10.0.0.1")
    limiter.hit("10.0.0.2")


def test_sixth_sign_up_is_429_with_retry_after(client):
    signup_limiter.reset()
    for i in range(5):
        assert client.post("/users", json={**SIGNUP, "email": f"user{i}@example.com"}).status_code == 201
    response = client.post("/users", json={**SIGNUP, "email": "user5@example.com"})
    assert response.status_code == 429
    assert int(response.headers["Retry-After"]) > 0
`;

const AUDIT_LOG = `import json
import logging
from datetime import datetime, timezone

logger = logging.getLogger("acme.audit")


class AuditLog:
    def record(self, event: str, **fields) -> None:
        entry = {"event": event, "at": datetime.now(timezone.utc).isoformat(), **fields}
        logger.info(json.dumps(entry, sort_keys=True))

    def signup_blocked(self, ip: str, retry_after: int) -> None:
        self.record("signup.blocked", ip=ip, retry_after=retry_after)


audit_log = AuditLog()
`;

const EMAIL_OLD = 'from app.models.user import User\n\nSMTP_TIMEOUT_S = 10\n';
const EMAIL_NEW = 'from app.core.config import settings\nfrom app.models.user import User\n\nSMTP_TIMEOUT_S = settings.smtp_timeout_s\n';

export function buildScenario() {
  add({ fake: 'await-user' });
  init();
  sleep(700);
  say("I'll start from the sign-up path on the map.");
  sleep(300);
  read('toolu_read_route', 'app/routes/users.py', 'sign_up(): POST /users → UserService.register(body)');
  sleep(250);
  read('toolu_read_service', 'app/services/user_service.py', 'UserService.register(): duplicate check, hash, add, welcome email');
  sleep(250);
  read('toolu_read_config', 'app/core/config.py', 'Settings: ACME_* environment variables');
  mcp('toolu_title', 'set_chat_title', { title: 'Rate-limit sign-ups' });
  sleep(500);
  say('Sign-ups go through `POST /users` → `UserService.register()`. I\'ll put a per-IP sliding window in front of the service and make the limit a setting. The plan is on the map.');
  mcp('toolu_plan_v1', 'propose_plan', planV1);
  sleep(600);
  say('Good calls. Plan v2: the route answers 429 with a `Retry-After` header, and blocked attempts go to a new `AuditLog`.');
  mcp('toolu_plan_v2', 'propose_plan', planV2);
  sleep(500);

  step('toolu_s1', 'config', 'start');
  sleep(900);
  edit('toolu_e_config', 'app/core/config.py', '    password_hash_rounds: int = 12\n', '    password_hash_rounds: int = 12\n    signup_rate_limit: int = 5\n    signup_rate_window_s: int = 60\n');
  sleep(900);
  step('toolu_d1', 'config', 'done');

  step('toolu_s2', 'limiter', 'start');
  sleep(800);
  write('toolu_w_limit', 'app/core/rate_limit.py', RATE_LIMIT);
  sleep(1200);
  write('toolu_w_test', 'tests/test_rate_limit.py', RATE_LIMIT_TEST);
  sleep(4500);
  step('toolu_d2', 'limiter', 'done');

  step('toolu_s3', 'audit', 'start');
  sleep(800);
  write('toolu_w_audit', 'app/services/audit_log.py', AUDIT_LOG);
  sleep(900);
  step('toolu_d3', 'audit', 'done');

  step('toolu_s4', 'wire', 'start');
  sleep(800);
  edit(
    'toolu_e_svc_imports',
    'app/services/user_service.py',
    'from app.core.security import hash_password\n',
    'from app.core.rate_limit import RateLimited, SlidingWindowLimiter, signup_limiter\nfrom app.core.security import hash_password\n',
  );
  edit('toolu_e_svc_audit_import', 'app/services/user_service.py', 'from app.schemas.user import SignupRequest\n', 'from app.schemas.user import SignupRequest\nfrom app.services.audit_log import AuditLog, audit_log\n');
  edit(
    'toolu_e_svc_body',
    'app/services/user_service.py',
    `    def __init__(self, users: UserRepository, emails: EmailService) -> None:
        self.users = users
        self.emails = emails

    def register(self, request: SignupRequest) -> User:
        email`,
    `    def __init__(
        self,
        users: UserRepository,
        emails: EmailService,
        limiter: SlidingWindowLimiter = signup_limiter,
        audit: AuditLog = audit_log,
    ) -> None:
        self.users = users
        self.emails = emails
        self.limiter = limiter
        self.audit = audit

    def register(self, request: SignupRequest, client_ip: str) -> User:
        try:
            self.limiter.hit(client_ip)
        except RateLimited as blocked:
            self.audit.signup_blocked(client_ip, blocked.retry_after)
            raise
        email`,
  );
  sleep(900);
  say('Email hard-codes a 10 s SMTP timeout while Settings already has smtp_timeout_s. Wiring it up while I\'m here.');
  sleep(400);
  edit('toolu_e_email', 'app/services/email_service.py', EMAIL_OLD, EMAIL_NEW);
  sleep(700);
  edit(
    'toolu_e_route_imports',
    'app/routes/users.py',
    `from fastapi import APIRouter, Depends, HTTPException, status

from app.core.config import settings
from app.core.db import database
`,
    `from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.core.config import settings
from app.core.db import database
from app.core.rate_limit import RateLimited
`,
  );
  edit(
    'toolu_e_route_body',
    'app/routes/users.py',
    `def sign_up(body: SignupRequest, service: UserService = Depends(get_user_service)) -> UserOut:
    try:
        user = service.register(body)
    except DuplicateEmail:`,
    `def sign_up(body: SignupRequest, request: Request, service: UserService = Depends(get_user_service)) -> UserOut:
    try:
        user = service.register(body, client_ip=request.client.host)
    except RateLimited as limited:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many sign-ups from this address. Try again later.",
            headers={"Retry-After": str(limited.retry_after)},
        )
    except DuplicateEmail:`,
  );
  sleep(700);
  add({ fake: 'tool', id: 'toolu_pytest', name: 'Bash', input: { command: 'pytest -q', description: 'Run the tests' }, result: '.........\n9 passed in 0.62s' });
  sleep(900);
  step('toolu_d4', 'wire', 'done');
  sleep(300);
  say('Done. `POST /users` allows 5 sign-ups per minute per IP; the 6th gets 429 with `Retry-After`, and every blocked attempt is one line in the audit log. 9 tests pass.');
  result('Done.');

  add({ fake: 'await-user' });
  init();
  sleep(1200);
  say(
    [
      '1. **User service → Rate limiting**: `UserService.register()` is the one path every sign-up takes, so the limit holds for any caller, not only HTTP. The route only turns `RateLimited` into 429 with `Retry-After`.',
      '2. **Rate limiting**: no. The window lives in each process, so with 4 uvicorn workers one IP gets up to 20 sign-ups a minute. For several workers, back `SlidingWindowLimiter` with Redis: `hit()` is the only method to replace.',
    ].join('\n\n'),
  );
  result('Answered.');
  add({ fake: 'await-user' });

  writeFileSync(SCENARIO, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return SCENARIO;
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(buildScenario());

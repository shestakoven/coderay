import type { PlanFlow, PlanStepView, PlanTarget, PlanView } from '@ide/protocol';

interface Seed {
  key: string;
  title: string;
  rationale: string;
  targets: PlanTarget[];
}

function planOf(goal: string, seeds: Seed[], flow: PlanFlow, overrides: Partial<PlanView>): PlanView {
  const steps: PlanStepView[] = seeds.map((seed, index) => ({ ...seed, order: index + 1, status: 'pending' }));
  return {
    id: 'plan-1', version: 1, goal, status: 'proposed', approvedBy: null, steps,
    scope: { paths: [], globs: [] }, owners: {}, review: { auto: false, notes: [] }, feedback: null,
    proposedAt: 1, decidedAt: null, flow, ...overrides,
  };
}

export const userPlan = (overrides: Partial<PlanView> = {}): PlanView => planOf(
  'Add POST /users: validate the body, hash the password, store the user.',
  [
    { key: 'model', title: 'Extend the User model and add a migration', rationale: 'The users table has no email or password hash yet.', targets: [{ path: 'app/models/user.py', op: 'modify' }, { path: 'migrations/versions/0007_user_email.py', op: 'create' }] },
    { key: 'schemas', title: 'Add the UserCreate and UserRead schemas', rationale: 'The route must not accept or return the raw ORM model.', targets: [{ path: 'app/schemas/user.py', op: 'create' }] },
    { key: 'service', title: 'Write UserService.create_user', rationale: 'Business rules (unique email, hashing) stay out of the route.', targets: [{ path: 'app/services/user_service.py', op: 'create' }] },
    { key: 'route', title: 'Add the POST /users route', rationale: 'Thin handler: validate, call the service, map a duplicate to 409.', targets: [{ path: 'app/api/users.py', op: 'create' }, { path: 'app/api/router.py', op: 'modify' }] },
    { key: 'tests', title: 'Cover the endpoint with tests', rationale: 'Happy path, duplicate email, weak password.', targets: [{ path: 'tests/test_users_api.py', op: 'create' }] },
  ],
  {
    nodes: [
      { id: 'client', title: 'API client', sub: 'Person · browser or script', kind: 'actor', state: 'existing', steps: [], files: [] },
      { id: 'route', title: 'POST /users', sub: 'Endpoint · FastAPI', kind: 'endpoint', state: 'create', steps: ['route'], files: [{ op: '+', path: 'app/api/users.py', note: 'create_user handler' }, { op: '~', path: 'app/api/router.py', note: 'include users router' }] },
      { id: 'schemas', title: 'UserCreate · UserRead', sub: 'Schemas · Pydantic', kind: 'schema', state: 'create', steps: ['schemas'], files: [{ op: '+', path: 'app/schemas/user.py' }] },
      { id: 'service', title: 'UserService', sub: 'Service · create_user()', kind: 'service', state: 'create', steps: ['service'], files: [{ op: '+', path: 'app/services/user_service.py', note: 'create_user, EmailTakenError' }] },
      { id: 'security', title: 'security', sub: 'Module · hash_password()', kind: 'module', state: 'existing', steps: [], files: [] },
      { id: 'model', title: 'User', sub: 'Model · SQLAlchemy', kind: 'model', state: 'modify', steps: ['model'], files: [{ op: '~', path: 'app/models/user.py', note: '+ email (unique), + password_hash' }] },
      { id: 'session', title: 'get_session', sub: 'Dependency · AsyncSession', kind: 'module', state: 'existing', steps: [], files: [] },
      { id: 'db', title: 'users', sub: 'Table · PostgreSQL', kind: 'store', state: 'modify', steps: ['model'], files: [{ op: '+', path: 'migrations/versions/0007_user_email.py', note: 'add columns, unique index' }] },
      { id: 'tests', title: 'test_users_api', sub: 'Tests · pytest', kind: 'test', state: 'create', steps: ['tests'], files: [{ op: '+', path: 'tests/test_users_api.py', note: '3 cases' }] },
    ],
    edges: [
      { from: 'client', to: 'route', label: 'POST {email, password}', state: 'new', step: 'route' },
      { from: 'route', to: 'schemas', label: 'validate', state: 'new', step: 'route' },
      { from: 'route', to: 'service', label: 'create_user(data)', state: 'new', step: 'route' },
      { from: 'service', to: 'security', label: 'hash_password', state: 'new', step: 'service' },
      { from: 'service', to: 'model', label: 'User(...)', state: 'new', step: 'service' },
      { from: 'service', to: 'session', label: 'add + commit', state: 'new', step: 'service' },
      { from: 'session', to: 'db', label: 'SQL', state: 'existing' },
      { from: 'model', to: 'db', label: 'maps to', state: 'existing' },
      { from: 'tests', to: 'route', label: 'TestClient', state: 'new', step: 'tests' },
    ],
  },
  overrides,
);

export const limitPlan = (overrides: Partial<PlanView> = {}): PlanView => planOf(
  'Replace the in-memory throttle with a Redis-backed limiter: 60 requests per minute per user.',
  [
    { key: 'settings', title: 'Add the rate-limit settings', rationale: 'Limit and Redis URL must be configurable per environment.', targets: [{ path: 'app/config.py', op: 'modify' }] },
    { key: 'redis', title: 'Introduce the Redis client', rationale: 'The in-memory counter breaks with more than one worker.', targets: [{ path: 'app/infra/redis.py', op: 'create' }, { path: 'docker-compose.yml', op: 'modify' }] },
    { key: 'limiter', title: 'Write RateLimitMiddleware', rationale: 'One place decides 429 for every route.', targets: [{ path: 'app/middleware/rate_limit.py', op: 'create' }] },
    { key: 'auth', title: 'Pass the user id from AuthMiddleware', rationale: 'The limiter keys on the user, not on the IP.', targets: [{ path: 'app/middleware/auth.py', op: 'modify' }] },
    { key: 'throttle', title: 'Remove the in-memory throttle', rationale: 'Nothing calls it once the middleware is in place.', targets: [{ path: 'app/utils/throttle.py', op: 'delete' }, { path: 'tests/test_throttle.py', op: 'delete' }] },
  ],
  {
    nodes: [
      { id: 'client', title: 'API client', sub: 'Person · browser or script', kind: 'actor', state: 'existing', steps: [], files: [] },
      { id: 'auth', title: 'AuthMiddleware', sub: 'Middleware · JWT', kind: 'service', state: 'modify', steps: ['auth'], files: [{ op: '~', path: 'app/middleware/auth.py', note: 'set request.state.user_id' }] },
      { id: 'limiter', title: 'RateLimitMiddleware', sub: 'Middleware · 60 req/min', kind: 'service', state: 'create', steps: ['limiter'], files: [{ op: '+', path: 'app/middleware/rate_limit.py', note: 'fixed window, 429 + Retry-After' }] },
      { id: 'redis', title: 'Redis', sub: 'Store · rate:{user}:{minute}', kind: 'external', state: 'create', steps: ['redis'], files: [{ op: '+', path: 'app/infra/redis.py', note: 'async client, health check' }, { op: '~', path: 'docker-compose.yml', note: '+ redis service' }] },
      { id: 'settings', title: 'Settings', sub: 'Module · pydantic-settings', kind: 'module', state: 'modify', steps: ['settings'], files: [{ op: '~', path: 'app/config.py', note: '+ RATE_LIMIT_PER_MIN, + REDIS_URL' }] },
      { id: 'routes', title: 'API routes', sub: 'Endpoints · FastAPI', kind: 'endpoint', state: 'existing', steps: [], files: [] },
      { id: 'throttle', title: 'throttle', sub: 'Module · in-memory dict', kind: 'module', state: 'delete', steps: ['throttle'], files: [{ op: '-', path: 'app/utils/throttle.py' }, { op: '-', path: 'tests/test_throttle.py' }] },
    ],
    edges: [
      { from: 'client', to: 'auth', label: 'Bearer token', state: 'existing' },
      { from: 'auth', to: 'routes', label: 'request', state: 'removed', step: 'limiter' },
      { from: 'auth', to: 'limiter', label: 'user_id', state: 'new', step: 'auth' },
      { from: 'limiter', to: 'routes', label: 'pass · or 429', state: 'new', step: 'limiter' },
      { from: 'limiter', to: 'redis', label: 'INCR + EXPIRE', state: 'new', step: 'limiter' },
      { from: 'limiter', to: 'settings', label: 'limit', state: 'new', step: 'limiter' },
      { from: 'redis', to: 'settings', label: 'REDIS_URL', state: 'new', step: 'redis' },
      { from: 'routes', to: 'throttle', label: 'check()', state: 'removed', step: 'throttle' },
    ],
  },
  overrides,
);

// done = null: the plan waits for the user. Otherwise the first `done` steps are done and the next one is active.
export function withProgress(plan: PlanView, done: number | null): PlanView {
  if (done === null) return { ...plan, status: 'proposed', approvedBy: null, steps: plan.steps.map((step) => ({ ...step, status: 'pending' })) };
  return {
    ...plan,
    status: done >= plan.steps.length ? 'done' : 'approved',
    approvedBy: 'user-card',
    steps: plan.steps.map((step, index) => ({ ...step, status: index < done ? 'done' : index === done ? 'active' : 'pending' })),
  };
}

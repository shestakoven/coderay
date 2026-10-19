// The agent SDK writes these into the core's own environment, which terminals and other spawns would inherit: one as it loads, one at every query().
const SDK_WRITES = ['NoDefaultCurrentDirectoryInExePath', 'CLAUDE_AGENT_SDK_VERSION'];

type EnvSnapshot = Record<string, string | undefined>;

function snapshot(): EnvSnapshot {
  return Object.fromEntries(SDK_WRITES.map((name) => [name, process.env[name]]));
}

export function restoreEnv(saved: EnvSnapshot): void {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

export function keepingEnv<T>(run: () => T): T {
  const saved = snapshot();
  try {
    return run();
  } finally {
    restoreEnv(saved);
  }
}

export const ENV_BEFORE_SDK = snapshot();

export const LAUNCH_TOKEN_ENV = 'IDE_CORE_TOKEN';

// The variable must not stay in process.env: every child of the core, the agent included, would inherit the UI token.
export function takeLaunchToken(env: NodeJS.ProcessEnv, generate: () => string): string {
  const given = env[LAUNCH_TOKEN_ENV];
  delete env[LAUNCH_TOKEN_ENV];
  return given || generate();
}

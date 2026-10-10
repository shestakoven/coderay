// First, so that it reads the core's environment before the SDK writes to it as it loads.
import { ENV_BEFORE_SDK, keepingEnv, restoreEnv } from './sdk-env';
import { setTimeout as delay } from 'node:timers/promises';
import { query, type CanUseTool, type Options, type PermissionResult, type SDKUserMessage, type SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { claudeEnv, spawnClaude, type SpawnedClaude } from './claude-process';
import type { AgentTransport, Launch, TransportSink } from './transport';

restoreEnv(ENV_BEFORE_SDK);

// How long claude's stdout gets to close after claude exits; a child holding it open must not stall the exit report.
const DRAIN_AFTER_EXIT_MS = 1000;
// The SDK runs a path with these endings through a JavaScript runtime and puts the path before claude's flags; CodeRay runs the command itself.
const SCRIPT = /\.(?:js|mjs|tsx|ts|jsx)$/;
// The SDK drops these from claude's environment, so the core passes them on to claude and its tools.
const KEPT_FROM_CORE = ['NODE_OPTIONS', 'DEBUG'];
const CANCELLED: PermissionResult = { behavior: 'deny', message: 'The request was cancelled.' };

export function sdkOptions(launch: Launch): Options {
  return {
    pathToClaudeCodeExecutable: launch.claude.command,
    cwd: launch.cwd,
    env: claudeEnv(launch.claude),
    ...(launch.resume ? { resume: launch.claudeSessionId } : { sessionId: launch.claudeSessionId }),
    ...(launch.model !== null ? { model: launch.model } : {}),
    ...(launch.effort !== null ? { effort: launch.effort } : {}),
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    disallowedTools: launch.disallowedTools,
    systemPrompt: { type: 'preset', preset: 'claude_code', snapshot: false, ...(launch.gate ? { append: launch.gate.appendSystemPrompt } : {}) },
    ...(launch.gate ? { settings: launch.gate.settingsPath } : {}),
    // The config holds idecore's bearer secret: a file only the user can read, never inline JSON in claude's argv.
    extraArgs: { 'mcp-config': launch.mcpConfigPath },
  };
}

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly queued: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    this.queued.push(message);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.queued.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }
}

export function startSdkTransport(launch: Launch, sink: TransportSink): AgentTransport {
  const core = claudeEnv(launch.claude);
  const input = new InputQueue();
  const pending = new Map<string, (result: PermissionResult) => void>();
  // The SDK reads claude's control requests apart from its messages: delivering a request after the messages already read keeps a prompt behind its tool call.
  const later = (value: object): void => {
    setImmediate(() => sink.message(value));
  };
  const canUseTool: CanUseTool = (toolName, toolInput, { signal, requestId }) => new Promise<PermissionResult>((resolve) => {
    if (signal.aborted) {
      resolve(CANCELLED);
      return;
    }
    pending.set(requestId, (result) => {
      pending.delete(requestId);
      resolve(result);
    });
    signal.addEventListener('abort', () => {
      const settle = pending.get(requestId);
      if (!settle) return;
      settle(CANCELLED);
      later({ type: 'control_cancel_request', request_id: requestId });
    }, { once: true });
    later({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: toolName, input: toolInput } });
  });
  const started: { claude?: SpawnedClaude } = {};
  const q = keepingEnv(() => query({
    prompt: input,
    options: {
      ...sdkOptions(launch),
      canUseTool,
      spawnClaudeCodeProcess: (options: SpawnOptions) => {
        const flags = SCRIPT.test(launch.claude.command) ? options.args.slice(1) : options.args;
        const env = { ...options.env };
        for (const name of KEPT_FROM_CORE) if (core[name] !== undefined) env[name] = core[name];
        started.claude = spawnClaude(launch.claude.command, [...launch.claude.args, ...flags], options.cwd ?? launch.cwd, env, { killGraceMs: launch.killGraceMs, pidDir: launch.pidDir });
        return started.claude.child;
      },
    },
  }));
  // query() starts claude before it returns; only startup() defers the spawn.
  const claude = started.claude;
  if (!claude) throw new Error('The agent SDK did not start claude.');
  const drained = (async () => {
    try {
      for await (const message of q) sink.message(message);
    } catch {
      // The stream stops when claude exits; `exited` reports how.
    }
  })();
  const exited = claude.exited.then(async (exit) => {
    await Promise.race([drained, delay(DRAIN_AFTER_EXIT_MS, undefined, { ref: false })]);
    for (const settle of [...pending.values()]) settle(CANCELLED);
    input.close();
    q.close();
    return exit;
  });
  // A control request fails once claude has exited, which `exited` reports.
  const ignore = (): void => {};
  return {
    pid: claude.child.pid,
    exited,
    send: (message) => input.push(message),
    interrupt: () => void q.interrupt().catch(ignore),
    stopTask: (taskId) => void q.stopTask(taskId).catch(ignore),
    respond: (response) => pending.get(response.request_id)?.(response.subtype === 'success' ? response.response : { behavior: 'deny', message: response.error }),
    setModel: (model) => q.setModel(model ?? undefined),
    // SIGTERM only, with stdin left open: a claude still writing is not told to stop by EOF, and the SIGKILL that follows ends one that ignores the signal.
    kill: () => {
      void claude.kill();
      return exited;
    },
  };
}

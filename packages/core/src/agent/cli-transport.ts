import { randomUUID } from 'node:crypto';
import { parseJson } from '../json';
import { startClaude } from './claude-process';
import { gateArgs, type AgentTransport, type Launch, type TransportSink } from './transport';

export function cliArgs(launch: Launch): string[] {
  return [
    '-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages',
    launch.resume ? '--resume' : '--session-id', launch.claudeSessionId,
    ...(launch.model !== null ? ['--model', launch.model] : []),
    ...(launch.effort !== null ? ['--effort', launch.effort] : []),
    '--mcp-config', launch.mcpConfigPath,
    '--disallowedTools', launch.disallowedTools.join(','),
    ...gateArgs(launch.gate),
    '--dangerously-skip-permissions',
    '--permission-prompt-tool', 'stdio',
  ];
}

export function startCliTransport(launch: Launch, sink: TransportSink): AgentTransport {
  const child = startClaude(launch.claude, cliArgs(launch), launch.cwd, (line) => {
    if (line.trim() !== '') sink.message(parseJson(line) ?? line);
  }, { killGraceMs: launch.killGraceMs });
  return {
    pid: child.pid,
    exited: child.exited,
    send: (message) => child.write(message),
    interrupt: () => child.write({ type: 'control_request', request_id: `interrupt-${randomUUID()}`, request: { subtype: 'interrupt' } }),
    stopTask: (taskId) => child.write({ type: 'control_request', request_id: `stop-task-${randomUUID()}`, request: { subtype: 'stop_task', task_id: taskId } }),
    respond: (response) => child.write({ type: 'control_response', response }),
    kill: () => child.kill(),
  };
}

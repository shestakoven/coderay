Provenance of `../transcripts/crash-gap.jsonl`: curated from the transcript shape Task 1 recorded as row c42 (claude 2.1.285), with `$SESSION` and `$CWD` placeholders, one duplicated `tool_use` id, one torn line and one unfinished call added on purpose.

# Stream fixtures for the fake claude

`test/fake-claude/fake-claude.mjs` replays these files (spec §8 "Integration"). Each line is one of two things:
- a stream-json event as `claude` 2.1.281 prints it, trimmed to the fields the IDE reads plus `type`, `subtype` and `session_id`;
- a directive for the fake, listed below.

Trimming keeps a recording's field names and the order of the events it keeps. It never adds a field or an event the recording does not have. Dropped events are named in the provenance column. `init` keeps `cwd`, `session_id`, `model`, `claude_code_version`, `mcp_servers` and `permissionMode`; its `tools` list is dropped because the IDE does not read it. Real ids are replaced by readable ones (`toolu_fx_…`, `task_fx_…`, `req_fx_…`), and the session id by `$SESSION`.

| Directive | Effect |
|---|---|
| `{"fake":"await-user"}` | Wait for the next user message on stdin. A turn is open from then until the next `await-user`. |
| `{"fake":"sleep","ms":N}` | Wait N ms; an interrupt ends the wait at once. |
| `{"fake":"await-control-response","request"?}` | Wait for the IDE's `control_response` (to the request with id `request` when given, else any); an interrupt ends the wait. The answer's allow or deny is kept for `when`. |
| `{"fake":"spawn-sleeper"}` | Start a child process that runs until it is killed, and record its pid. |
| `{"fake":"ignore-sigterm"}` | Record each SIGTERM and keep running. |
| `{"fake":"ignore-stdin-close"}` | Keep running when stdin closes, and record that. |
| `{"fake":"stderr","text":"…"}` | Write a line to stderr. |
| `{"fake":"exit","code":N}` | Flush stdout and stderr, then exit with code N. |
| `{"fake":"hang"}` | Never answer; runs until killed or until stdin closes. |
| `{"fake":"tool","id","name","input","result"?,"apply"?,"streamed"?}` | Emit a `tool_use`, run the `PreToolUse` hooks of `--settings` with the CLI's stdin shape, then either emit a hook error `tool_result` (exit 2, or a JSON `deny` on exit 0; JSON on any other exit is ignored) or, with `apply`, perform the call (Write writes, Edit replaces, Bash runs `sh -c`) and emit `result`. Any other hook failure lets the call run. `"streamed": false` skips the `tool_use`, standing for one still in claude's output buffer. An interrupt kills a running hook. |
| `{"fake":"mcp","id","tool","input"}` | The same for `mcp__idecore__<tool>`: emit the `tool_use`, run the hooks, then call the tool on the `idecore` server of `--mcp-config` with the MCP SDK client and emit its text as the `tool_result`. An interrupt aborts the call (the SDK sends `notifications/cancelled`). |
| `{"fake":"mcp-write","id","server","tool","files":[{"path","content"}],"perFileMs"?,"honorCancel"?,"parent"?,"skipHook"?}` | Stands for a configured MCP tool that writes files without a file-writer event: emit a `tool_use` named `mcp__<server>__<tool>`, run the hooks, write the files one by one `perFileMs` apart (paths relative to `$CWD`, parents created), then emit an `ok` `tool_result`. On an interrupt, `honorCancel` (default true) stops writing at once (c19); `false` ends the turn but keeps writing until done (c19b). Records `{ mcpWrite: { id, tool, written } }` when it stops writing. |
| `"parent":"<toolu id>"` on `tool` and `mcp-write` | The call's `tool_use` and `tool_result` carry `parent_tool_use_id`: a subagent's own call (v4). The hook input carries no parent. |
| `"skipHook":true` on `tool` and `mcp-write` | No hook runs and no hook record is written; the call ends `ok`, as when a hook failed open (spike 2b, 2c). |
| `"background":true` on a Bash `tool` | The command is spawned detached; the step returns at once with the `result` and a `task_started` (`task_type: "local_bash"`, `is_backgrounded: true`, `tool_use_id`). The process survives every interrupt (c6, c7). Records `{ background: { id, pid } }`. |
| `{"fake":"task-end","toolUseId","status"?,"after"?}` | Without blocking, emit `task_updated` and `task_notification` (status default `completed`) once the background process of the Bash call `after` (default `toolUseId`) has exited, even with no turn open. |
| `"when":"allow"\|"deny"` on an event line | The event is emitted only if the last answer taken by `await-control-response` had that behavior. |

The fake replaces `$SESSION` with the id passed as `--resume` or `--session-id`, and `$CWD` with its working directory, the project root.

An interrupt during an open turn is answered in the order of `spike/out/c5b-interrupt-turn-with-subagent.jsonl`, `fx-interrupt-bash.jsonl` and `c22f-prompt-cancel.jsonl`:
1. for each async subagent still running (`task_type: "local_agent"`), a `task_updated` `killed` and a `task_notification` `stopped`, then a `control_cancel_request` for a `control_request` still waiting for its answer;
2. a `control_response` success with `still_queued: []`;
3. a `task_notification` with status `stopped` for each foreground task (`is_backgrounded: false`) the fixture started;
4. a rejected `tool_result` for each main-thread `tool_use` still unanswered, with the rejection text of the recording, then the text block `[Request interrupted by user for tool use]`;
5. a `result` with subtype `error_during_execution` and the recorded `errors` line.

The fake then skips to the next `await-user`. An interrupt with no turn open (before the first `await-user` turn, or after a `result`) gets the kill of running async subagents (c5) and the `control_response`, and starts no turn (spike c9). Background `local_bash` tasks are never killed by an interrupt (c6, c7); the fake kills their process groups only when it ends itself (stdin close, SIGTERM, SIGINT or an `exit` step), as real claude does not orphan its tasks.

Fixture-writing notes:
- An idle interrupt kills a running subagent, so do not script a completion line for one that a test interrupts.
- New fixtures should give `await-control-response` a `request` id.
- After `task-end` the fake emits only `task_updated` and `task_notification`: no agent-initiated `init`/`result` with `origin: task-notification` (c8) and no `end_time` on `task_updated`.
- Leniency: `Edit` silently does nothing when `old_string` is missing; `mcp-write` and `tool` do not validate their fields.

| Fixture | Scenario | Provenance |
|---|---|---|
| `multi-turn.jsonl` | Three user turns answered with text; one MCP server in `init`. | Trimmed from `spike/out/fx-multi-turn.jsonl` (Plan 3 Task 1, claude 2.1.281, haiku, spike MCP server configured). Dropped hook, `thinking_tokens` and `status` events. |
| `interrupt-bash.jsonl` | A foreground Bash call that runs until it is interrupted, then an `ALIVE` turn. | Trimmed from `spike/out/fx-interrupt-bash.jsonl`, with its `task_started` (`is_backgrounded: false`). The running call is a `sleep` directive, so the fake produces the interrupt answer itself. |
| `interrupt-subagent.jsonl` | An async subagent started in one turn is still running when Stop interrupts the next turn's foreground Bash. | Trimmed from `spike/out/c5b-interrupt-turn-with-subagent.jsonl`. Dropped the subagent's own calls; the `sleep` directive stands for the running Bash, so the fake produces the interrupt answer, including the subagent's kill. |
| `async-subagent.jsonl` | An async subagent: the user turn closes, the subagent works, an agent-initiated turn runs, then a follow-up user turn. | Trimmed from `spike/out/fx-async-subagent.jsonl`. The `sleep` directive stands for the subagent's running time. |
| `ask-user-question.jsonl` | AskUserQuestion with two questions: the `can_use_tool` request waits for the IDE's answer inside the turn. | Trimmed from `spike/out/c22b-ask.jsonl` (Plan 3 Task 2). The final text is shortened. |
| `plan-approval.jsonl` | EnterPlanMode switches to plan mode; ExitPlanMode waits for approval inside the turn; approval switches back to bypass. | Trimmed from `spike/out/c22c-plan-approve.jsonl`. Dropped the Write of the plan file and the Write and Read after approval; the plan text and `planFilePath` are shortened. |
| `unexpected-prompt.jsonl` | A `can_use_tool` request for a tool the IDE does not ask the user about. | Synthetic: `spike/out/c22e-protected-writes.jsonl` recorded no such request. The request has the recorded field names; the denied `tool_result` has the shape of `c22d-plan-reject.jsonl`. |
| `crash-mid-turn.jsonl` | claude exits with code 1 during a tool call. | Synthetic: a crash is a process exit, not a stream event. |
| `old-cli.jsonl` | One turn from a CLI older than the minimum version. | Synthetic: one turn in the recorded shape with `claude_code_version` set to `2.1.100`. |
| `hang.jsonl` | A claude that never answers. | Synthetic, for stale-process and kill tests. |
| `stubborn.jsonl` | A claude that ignores SIGTERM and has a child process. | Synthetic, for the SIGKILL fallback. |
| `keeps-running.jsonl` | A claude that outlives its stdin. | Synthetic, for the core-exit test. |
| `explain-then-bash.jsonl` | An assistant message, a Bash call, its result and a closing message. | Synthetic, with the event shapes of multi-turn.jsonl and interrupt-bash.jsonl. |
| `gate-small-plan.jsonl` | A small plan on `src/app.ts` (approved at once), its step, and the Write it covers. | Synthetic: event shapes from `multi-turn.jsonl` and `interrupt-bash.jsonl`; the hook error text is that of spike c17 ("PreToolUse:Write hook error: …"). |
| `gate-big-plan.jsonl` | The same with a plan on the directory `src`, which waits for the user. | Synthetic: event shapes from `multi-turn.jsonl` and `interrupt-bash.jsonl`; the hook error text is that of spike c17 ("PreToolUse:Write hook error: …"). |
| `gate-no-plan.jsonl` | A Write with no plan. | Synthetic: event shapes from `multi-turn.jsonl` and `interrupt-bash.jsonl`; the hook error text is that of spike c17 ("PreToolUse:Write hook error: …"). |
| `gate-out-of-plan.jsonl` | The small plan, then a Write to `src/other.ts`, outside it. | Synthetic: event shapes from `multi-turn.jsonl` and `interrupt-bash.jsonl`; the hook error text is that of spike c17 ("PreToolUse:Write hook error: …"). |
| `gate-out-of-plan-unstreamed.jsonl` | The same, with the out-of-plan Write's `tool_use` never streamed. | Synthetic: event shapes from `multi-turn.jsonl` and `interrupt-bash.jsonl`; the hook error text is that of spike c17 ("PreToolUse:Write hook error: …"). |
| `gate-bash.jsonl` | A Bash call that only reads and one that writes a project file, with no plan. | Synthetic: event shapes from `multi-turn.jsonl` and `interrupt-bash.jsonl`; the hook error text is that of spike c17 ("PreToolUse:Write hook error: …"). |
| `silent-tool-turn.jsonl` | A turn with an assistant message, then a turn whose only output is a Bash call that keeps running. | Synthetic: event shapes from `explain-then-bash.jsonl`; the `sleep` directive keeps the second turn open. |
| `text-then-wait.jsonl` | A turn with an assistant message that stays open. | Synthetic: event shapes from `explain-then-bash.jsonl`; the `sleep` directive keeps the turn open. |
| `mcp-write`, `parent`, `skipHook`, `background`, `task-end`, `when` (directives above) | Synthetic, from spike rows: c19/c19b (MCP cancel honored or ignored), v4 (subagent call with `parent_tool_use_id`), 2b/2c (hook failed open), c6/c7 (background `local_bash` survives an interrupt), c5 (idle interrupt kills async subagents), c22b/c22f (prompt request and answer shapes). |

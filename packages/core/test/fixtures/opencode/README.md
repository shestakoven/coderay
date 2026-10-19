# Scenarios for the fake opencode server

`test/fake-opencode/fake-opencode.mjs` stands in for `opencode serve` 1.19: it prints the listening line, checks basic auth, answers CodeRay's routes itself (`/global/health`, `/global/dispose`, `/instance/dispose`, `/agent`, `/config`, `/config/providers`, `/provider`, `/provider/auth`, `/auth/:id`, `/command`, `/experimental/tool/ids`, `/permission`, `/session`, `/session/:id`, `/session/:id/prompt_async`, `/session/:id/command`, `/session/:id/abort`, `/permission/:id/reply`, `/question/:id/reply`, `/question/:id/reject`, `/event`) and replays one of these files on each `prompt_async` or `command`. Shapes are trimmed from the recorded transcripts of opencode 1.19.0 in `recorded/` (sanitized copies of the 2026-10-13 and 2026-10-17 verification runs; `docs/spike/2026-10-17-opencode-e3-verified.md` explains them). Every line is one of:

| Line | Effect |
|---|---|
| `{"type": …, "properties": …}` | An SSE event, sent as is after `$SESSION`, `$MESSAGE`, `$CWD` are filled (a part without an `id` gets `prt_<n>`). |
| `{"ask": "edit" \| "bash" \| "task" \| "webfetch" \| "external_directory", "tool"?, "callID", "patterns", "metadata", "input", "always"?, "apply"?, "output"?, "parallel"?, "before"?, "session"?: "child" \| "unannounced" \| <id>, "answeredBy"?, "running"?: "after"}` | Sends the tool part `running` with `input` (tool `tool`, default the ask), then `permission.asked` (on a child session, after a `session.created` with the chat as `parentID`, when `session` is `child`; on such a child with no `session.created`, as a task resumed by `task_id` would be, when it is `unannounced`; on the session `<id>`, which nobody announced and `GET /session/:id` answers as a root, when it is another string), and waits for `/permission/:id/reply`. `once`: `apply` (a file or a list) is written and the part `completed` follows (a `task` part completes when the turn ends, as a subagent's does). `reject` with a message: the part ends `error` with the feedback and the turn goes on. A plain `reject`: the part ends `error` and the turn ends. `before`: an ask 1.19 sends ahead of another for the same call (`external_directory` before a write outside the project): `once` sends nothing more. `parallel`: the next line plays at once (two pending asks on one session). `answeredBy`: another client answers the ask with that reply right after it is asked. `running: "after"`: the part is only `pending` when the ask is sent and turns `running` 50 ms later, as 1.19 does for some bash calls. |
| `{"question": {"text", "options", "callID"?, "session"?}}` | Sends the `question` tool part `running`, then `question.asked` (on the chat's session, or one chosen as an ask's `session` is), and waits. `/question/:id/reply` → `question.replied`, the part `completed`; `/question/:id/reject` → `question.rejected`, the part `error` "The user dismissed this question", and the turn ends. |
| `{"fake": "await-turn"}` | Ends this prompt's lines: `session.idle` is sent; the next lines play at the next prompt. Lines before the first `await-turn` play during the first prompt. |
| `{"fake": "sleep", "ms": N}` | Waits; `/abort` ends the wait. |
| `{"fake": "close-stream", "holdMs"?}` | Ends every open `/event` stream; what is sent until the client opens one again is lost to it (a held ask stays in `GET /permission`). `holdMs`: the next `GET /event` opens only that long after it comes, as a slow reconnect would. |
| `{"fake": "write", "path", "content"}` | Writes a file under the session's directory (stands for an allowed edit). |
| `{"fake": "spawn-sleeper"}` | Starts a `sleep 600` child in its own process group, records `{ sleeperPid }`; `/abort` kills it (as opencode kills a running bash); `/global/dispose` kills it too; SIGTERM alone does not (as the real server). |
| `{"fake": "error", "message", "session"?: false}` | Sends `session.error` with the chat's session id (or none when `session` is false, as a broken user skill's error). |

`$SESSION` is the chat's session id, `$MESSAGE` the assistant message id of the prompt, `$CWD` the directory, `$PASSWORD` the server's password (what `ps -E` would show the model).

## As 1.19 does

- **`POST /session`** sends `session.created` 20 ms before it answers, as a busy server may.
- **Ids.** Session ids carry the fake's pid (`ses_<pid>_<n>`), so a test can tell two fakes' records apart; asks are `per_…`, questions `que_…`, messages `msg_…`.
- **Restarts.** A fake started again with the same `FAKE_OPENCODE_RECORD` goes on from the line the previous one reached (a core restart). Its sessions (id, parent, ruleset, directory) are kept in `<record>.sessions.json`, so a restarted fake answers `GET /session/:id` for them. Any other id is answered too (opencode's database outlives a server), with the inline config's rules as its ruleset, except `FAKE_OPENCODE_GONE`, which is 404.
- **`GET /agent`** lists `build`, `compaction`, `explore`, `general`, `plan`, `summary`, `title` and any agent of the config, each with its rules as a **list** in evaluation order: 1.19's defaults, the agent's own defaults, the merged top-level `permission`, the merged `agent.<name>.permission`, and last the `external_directory <XDG_DATA_HOME>/opencode/tool-output/* allow` rule 1.19 appends.
- **`GET /config`** is the configured answer with `OPENCODE_CONFIG_CONTENT` deep-merged over it (a key keeps the position it first had, so a user's `*` stays before CodeRay's rules), and each `permission` map echoed with the known keys first (1.19's schema order), which is not the evaluation order.
- **Events.** `permission.replied` is `{sessionID, requestID, reply}`; `question.replied` `{sessionID, requestID, answers}`; `question.rejected` `{sessionID, requestID}`; `session.created` `{sessionID, info}`.
- **Replies.** A `reject` on one ask rejects the session's other pending asks too (`permission.replied` for each). `GET /permission` lists the pending asks in `permission.asked`'s shape.
- **`/abort`** (Q12-abort-leaves): `session.error` `MessageAbortedError`, every running tool part ends `error` "Tool execution aborted", the rest of the turn is skipped to the next `await-turn`, and `session.idle` follows. A held ask **stays pending** in `GET /permission` with no `permission.replied`; a later `/permission/:id/reply` answers 200 and sends it. A held question stays too. (The real server also sent a second `session.idle` a moment after an abort; the fake sends one.)
- **`/session/:id/prompt_async`** answers 204 at once; a prompt while the session is busy is folded into the running turn (Q12b: no second turn).
- **`/session/:id/command`** answers `{info, parts}` when the turn ends, before `session.idle` (Q10). A `model` that is not a string is answered 400 as 1.19 does; `system` is recorded and has no effect.
- **Auth** (Q1). `PUT /auth/:id` persists to `$XDG_DATA_HOME/opencode/auth.json` (else `<cwd>/fake-data/…`). `GET /provider`'s `connected` lists an authed provider at once; `GET /config/providers` lists it (with one stub model) only after `POST /instance/dispose` or a restart, and only when `GET /provider` knows it (`openai`, `anthropic`). The fake refuses to start when an `XDG_*` variable points at the real default home.
- **`GET /experimental/tool/ids`**: the 14 built-in tool ids of 1.19 (F1).

## Environment

| Variable | Effect |
|---|---|
| `FAKE_OPENCODE_SCENARIO`, `FAKE_OPENCODE_RECORD` | The scenario file; the record file (one JSON line per start, request, session, prompt, reply and sleeper; the start line lists `opencodeVars`: every `OPENCODE_*` name in the fake's environment). |
| `FAKE_OPENCODE_VERSION` | `--version` and health's `version` (default `1.19.0`). |
| `FAKE_OPENCODE_AGENTS` | JSON answered for `GET /agent` as is. |
| `FAKE_OPENCODE_CONFIG` | JSON for the user's config, before the merge (default `{}`); `/agent` derives from it too. |
| `FAKE_OPENCODE_PROVIDERS` | JSON for `GET /config/providers` (default: `opencode` with `nemotron-3.5-lightning-free` (262144, no variants) and `gpt-oss-120b-free` (131072, variants `low`/`high`)). |
| `FAKE_OPENCODE_TOOL_IDS` | JSON for `GET /experimental/tool/ids`. |
| `FAKE_OPENCODE_AUTH=fail` | `PUT /auth/:id` answers 400 with the request body quoted in its message. |
| `FAKE_OPENCODE_DB_BUSY=<n>` | The first `n` starts with this record file exit with code 1 before they listen, as 1.19 does beside another server of the same home that sets the database up: the first with "Failed query:", the rest with "database is locked" on stderr. |
| `FAKE_OPENCODE_NO_LISTEN=1` | Never prints the listening line. |
| `FAKE_OPENCODE_LISTEN_STREAM=stderr` | Prints it on stderr. |
| `FAKE_OPENCODE_HEALTH=down` | Health answers 503. |
| `FAKE_OPENCODE_DISPOSE=hang` | `/global/dispose` never answers. |
| `FAKE_OPENCODE_ABORT=ignore` | `/session/:id/abort` answers 200 and the turn goes on: no idle comes. |
| `FAKE_OPENCODE_UNKNOWN_MODEL=1` | Every prompt gets `session.error` `UnknownError` "Model not found: <provider>/<model>. Did you mean: …" (1.19's words for a model of a provider it has not connected) and `session.idle`. |
| `FAKE_OPENCODE_GONE=<id>` | `GET /session/<id>` is 404. |
| `FAKE_OPENCODE_REPLIED=1` | At the first prompt, before its turn plays, a `permission.replied` `once` nobody asked for (`per_nobody`): the tripwire; `=reject` replies `reject`. |
| `FAKE_OPENCODE_RULES_FLIP=1` | After the first prompt `build` gains a last rule `edit * allow`: the per-prompt self-check. |

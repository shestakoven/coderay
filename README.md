# CodeRay

An IDE for working with AI coding agents without losing the mental model of your own codebase.

The agent's changes don't scroll past as a text stream. The main surface is a **live map of the codebase**: before the agent touches a file it must show its plan on the map and wait for your approval, and every change stays attributable to the plan step and the reason that caused it.

- **Live code map** for TypeScript and Python (tree-sitter), grouped into logical components and updated live as files change.
- **Plan before action**: the agent proposes a plan, you approve it, the map shows the steps as they run.
- **Out-of-plan control**: a change outside the approved plan is blocked, asked about, or flagged, depending on the mode you choose.
- **Review by step**: click a map node to see its changes grouped by the plan step (with the step's rationale), and roll back any step without overwriting your own edits.
- **Chat over [Claude Code](https://docs.claude.com/en/docs/claude-code)** in headless mode; background models (Haiku, local embeddings) do the grouping and summaries.

Status: early (0.x), expect rough edges. The only packaged build is macOS on Apple silicon.

## Install

Download the latest `.dmg` from [Releases](https://github.com/shestakoven/coderay/releases/latest) and drag CodeRay to Applications. The app is signed and notarized and updates itself. It needs the [`claude` CLI](https://docs.claude.com/en/docs/claude-code) installed and logged in.

## Develop

Requires Node ≥ 24 and pnpm 10.

```
pnpm install
pnpm desktop               # the Electron window around the dev stack, with hot reload
pnpm start                 # core + built UI in a browser, for the project in the current directory
pnpm check                 # test hygiene, typecheck, unit tests
pnpm e2e                   # Playwright
```

Layout: `packages/core` (agent session, map, plan enforcement), `packages/ui` (React UI), `packages/protocol` (shared types), `packages/desktop` (Electron shell, macOS build and releases; see its README).

## License

[MIT](LICENSE)

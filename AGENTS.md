# AGENTS.md

## Project Summary

- `agent-cli` is a terminal-based agentic coding assistant implemented in TypeScript and ESM.
- The runtime centers on `agent.ts`, which wires together the TUI, conversation state, tool loading, approvals, streaming, shell execution, and worktree support.
- Tool definitions live in `tools/*.md`; executable implementations live in the matching `tools/*.ts` module.
- The app operates in the current workspace and, when available, isolates edits in an agent-managed git worktree.
- Root `AGENTS.md` content is loaded as additive system guidance on startup.

## Standard Commands

- Prefer Bun-based commands when working in this repo.
- Install dependencies: `bun install`
- Start the app: `bun run agent.ts`
- Typecheck: `bun typecheck`
- Tests: `bun test`
- Format the whole repo: `bun run format`
- Format specific files: `bun run format:file -- <paths...>`
- After making code changes, run formatting when needed, then run `bun typecheck`.

## Repo Map

- `agent.ts`
  - Main entrypoint and orchestration for UI, tool execution, approvals, streaming, persistence, and worktree integration.
- `worktree.ts`
  - Git worktree session management, workspace path resolution, baseline capture, merge/downsync handling, conflict tracking, revert, and upmerge flows.
- `lib/llm.ts`
  - Model/provider integration, streaming, embeddings, and model listing for remote OpenAI-compatible backends and local Ollama.
- `lib/skills-index.ts`
  - Skill discovery under `.agents/skills/`, markdown chunking, embedding generation, and similarity search over indexed skill chunks.
- `lib/event-stream-decoder.ts`
  - SSE/event-stream decoder; covered by dedicated tests.
- `lib/agent/`
  - `commands.ts`: colon commands such as `:agents-md`, `:index`, `:model`, `:plan`, `:merge`, `:summarize`, `:worktree`
  - `config-store.ts`: persisted config, root `AGENTS.md` loading, `.agents/PLAN.md` bootstrap, shell approval persistence
  - `conversation-store.ts`: active/previous conversation state and history persistence
  - `approvals.ts`: tool and shell approval flow
  - `shell-runner.ts`, `shell-session.ts`: shell execution and transcript formatting
  - `streaming.ts`, `stream-state.ts`: streaming loop and assistant stream state machine
  - `tools.ts`: tool definition parsing, validation, loading, seeded tool messages, and tool-result summaries
  - `view.ts`, `view-models.ts`, `menus.ts`, `input-controller.ts`: TUI behavior, menus, composer/history interactions
  - `summarize.ts`: transcript compaction helpers and summarization prompts
- `tools/`
  - Machine-readable tool docs (`*.md`) plus executable implementations (`*.ts`).
  - `system-prompt.md` is special: it is used as base prompt text and is not loaded as a callable tool.
  - `create_agents_context.ts` returns JSON containing the final markdown that `:agents-md` writes to the repo root.
- `test/`
  - Bun tests covering integration/worktree behavior plus the event stream decoder.
- `.agents/`
  - `PLAN.md`: scratchpad created on startup if missing
  - `shell.json`: workspace-managed shell approvals/startup command config
  - `skills/`: local skill packs with `SKILL.md`
  - `skills-index.json`: generated embedding index

## Important Invariants

- Tool definition filenames must match tool names exactly.
  - `lib/agent/tools.ts` enforces that `tools/<name>.md` declares the same name and that `tools/<name>.ts` exports `execute`.
- `tools/system-prompt.md` is excluded from tool loading and used only as prompt text.
- `agent.ts` always calls `ensurePlanFileReady()` during startup.
  - This creates `.agents/PLAN.md` if missing.
- The base system prompt now treats `.agents/PLAN.md` as the home for lightweight reflection on complex work.
  - For ambiguous or higher-risk tasks, expect the agent to outline a plan, note acceptance criteria, and capture knowledge gaps before editing.
- Initial tool context is seeded automatically.
  - `lib/agent/constants.ts` seeds `list_project_tree` and `read_file package.json` for normal sessions.
  - The AGENTS flow additionally seeds `read_file AGENTS.md`.
- Workspace paths for edit-sensitive flows must stay inside the workspace root.
  - `worktree.ts` resolves paths against the workspace root and throws if a path escapes it.
- `.agents/PLAN.md` is intentionally excluded from upmerge.
  - `worktree.ts` hard-codes it in `UPMERGE_IGNORED_PATHS`.
- The `:agents-md` flow is read-only until final writeback.
  - `commands.ts` restricts the sub-agent to discovery tools plus `create_agents_context`, then writes the returned markdown to `AGENTS.md`.
- Shell approval persistence supports exact strings and trailing-`*` prefix patterns.
  - For example, `bun test*` matches both `bun test` and targeted invocations such as `bun test test/event-stream-decoder.test.ts`.
  - Other wildcard placements are invalid and ignored when loading `.agents/shell.json`.

## Preferred Patterns

- When adding or changing a tool, update both files:
  - `tools/<name>.md` for schema/docs/metadata
  - `tools/<name>.ts` for implementation
- Keep path handling explicit and rooted.
  - Reuse workspace/worktree helpers instead of ad hoc path resolution.
- Preserve the current subsystem split inside `lib/agent/`.
  - UI, approvals, persistence, shell execution, streaming, commands, and summaries are already separated.
- Treat root `AGENTS.md` as additive guidance, not a replacement for `tools/system-prompt.md`.
- Keep generated workspace state in existing machine-managed locations rather than inventing new files/dirs.
- For ambiguous edit requests, prefer clarifying questions or explicit, testable acceptance criteria before changing code.
- For front-end or visual tasks, prefer `agent_web_browser`; ask for a runnable URL when needed and ask the user to verify visuals you cannot inspect directly.
- After meaningful refactors or interface changes, consider whether README/comments/agent guidance should be updated in the same change.
- Prefer Bun for local scripts and validation, even though `packageManager` is `pnpm@10.12.1` in `package.json`.

## Environment / Services

- Required for remote OpenAI-compatible access:
  - `OPENAI_API_BASE`
  - `OPENAI_API_KEY`
- Optional:
  - `OPENAI_EMBEDDING_MODEL` (defaults to `text-embedding-3-small`)
  - `OLLAMA_API_BASE` (defaults to `http://127.0.0.1:11434`)
- Model presets in `lib/agent/constants.ts`:
  - `anthropic:claude-sonnet-4-6`
  - `openai:gpt-5.4`
  - `google:gemini-3.1-pro-preview`
  - `ollama:qwen3.5:latest`
- Remote OpenAI-compatible model listing uses `/models`.
- Ollama model listing uses `/api/tags`.
- Embedding/index flows depend on the remote embedding model configuration, not Ollama.

## Persistence / Generated State

- Global config is stored under the OS config dir for `agent-cli`:
  - Non-Windows: `~/.config/agent-cli/...` unless `XDG_CONFIG_HOME` is set
  - Windows: `%APPDATA%\agent-cli\...`
- Persisted files include:
  - `config.json` for current model
  - workspace-scoped active and previous conversation state
  - workspace-scoped conversation history
  - workspace-scoped worktree session state under the config dir
- Workspace-managed/generated files include:
  - `.agents/PLAN.md`
  - `.agents/shell.json`
  - `.agents/skills-index.json`
- `.agents/shell.json` currently supports:
  - `approvedCommands`
  - `startupCommands`

## Validation

- After code changes, run `bun typecheck`.
- When behavior changes touch runtime flows, also run `bun test`.
- After tool changes, verify both sides of the contract still line up:
  - `tools/<name>.md` name matches filename
  - `tools/<name>.ts` exports `execute`
- If changing startup, config, or workspace state behavior, re-check:
  - `lib/agent/constants.ts`
  - `lib/agent/config-store.ts`
  - `worktree.ts`
- If changing streaming/SSE handling, re-check `lib/event-stream-decoder.ts` and its tests.

## Sharp Edges

- Remote model access is unavailable unless `OPENAI_API_BASE` and `OPENAI_API_KEY` are set.
  - Ollama chat models can still work locally via `ollama:*` model ids.
- Remote features like embeddings and remote model listing still depend on the OpenAI-compatible gateway env vars.
- Worktree behavior is optimistic, not guaranteed.
  - The initial note says a git worktree will be created on first edit when available.
  - Code should not assume worktree isolation is always active.
- Startup commands from `.agents/shell.json` may run inside the active worktree session.
- Skill indexing depends on embeddings and `.agents/skills-index.json`; `:index`/skill search may fail or go stale when embeddings are unavailable.
- The AGENTS generator only succeeds if the sub-agent actually calls `create_agents_context`; plain assistant text is treated as failure.

## Change Policy

- Do not invent new repo-level commands unless they are added to `package.json` or clearly supported by code/docs.
- Preserve machine-managed files and conventions:
  - `.agents/PLAN.md` is scratch space and is excluded from upmerge.
  - `.agents/shell.json` stores persisted shell approval/startup state.
  - `.agents/skills-index.json` is generated from local skills.
- Prefer small, subsystem-local edits over broad refactors unless the change clearly spans multiple modules.
- When editing tooling, keep the markdown contract and implementation synchronized.
- Do not weaken workspace path-safety checks or bypass the tool approval/worktree flows without strong evidence and corresponding tests.

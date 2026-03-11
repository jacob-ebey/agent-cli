# AGENTS.md

## Project Summary

- `agent-cli` is a terminal-based agentic coding assistant implemented in TypeScript and ESM.
- The runtime centers on `agent.ts`, which wires together the TUI, conversation state, tool loading, approvals, streaming, shell execution, and worktree support.
- Tool definitions live in `tools/*.md`; executable implementations live in the matching `tools/*.ts` module.
- The app operates in the current workspace and, when available, can isolate edits in an agent-managed git worktree.

## Standard Commands

- Install dependencies: `pnpm install`
- Start the app: `pnpm start`
- Typecheck: `pnpm typecheck`
- There are no declared build, lint, or test scripts beyond `typecheck` in `package.json`.

## Repo Map

- `agent.ts`
  - Main entrypoint and orchestration for UI, tool execution, approvals, streaming, and worktree integration.
- `worktree.ts`
  - Git worktree session management, workspace path resolution, baseline capture, restore, and upmerge helpers.
- `lib/llm.ts`
  - Model/provider integration, response streaming, embeddings, and model listing.
- `lib/skills-index.ts`
  - Skill discovery, markdown chunking, embedding generation, and similarity search over `.agents/skills/*/SKILL.md`.
- `lib/agent/`
  - `commands.ts`: colon commands such as `:agents-md`, `:index`, `:model`, `:plan`, `:summarize`, `:worktree`
  - `config-store.ts`: persisted config, root `AGENTS.md` loading, `.agents/PLAN.md` bootstrap, shell approval persistence
  - `conversation-store.ts`: active/previous conversation state and history persistence
  - `approvals.ts`: tool and shell approval flow
  - `shell-runner.ts`, `shell-session.ts`: shell execution and transcript formatting
  - `streaming.ts`: single-turn LLM/tool streaming loop
  - `tools.ts`: tool definition parsing, validation, loading, and seeded tool messages
  - `view.ts`, `view-models.ts`, `menus.ts`, `input-controller.ts`: TUI behavior and menus
- `tools/`
  - Machine-readable tool docs (`*.md`) plus executable implementations (`*.ts`).
  - `system-prompt.md` is special: it is used as the base system prompt and is not loaded as a callable tool.
- `.agents/skills/`
  - Local skill packs with `SKILL.md` files and optional supporting docs.
- `.agents/skills-index.json`
  - Generated embedding index for skill search.
- `.agents/shell.json`
  - Workspace-managed shell approval and startup command config.

## Important Invariants

- Tool definition filenames must match tool names exactly.
  - `lib/agent/tools.ts` enforces that `tools/<name>.md` declares the same name and that `tools/<name>.ts` exports `execute`.
- `tools/system-prompt.md` is excluded from tool loading and used only as prompt text.
- Workspace paths for edit-sensitive flows must stay inside the workspace root.
  - `worktree.ts` rejects paths that resolve outside the root.
- `agent.ts` always calls `ensurePlanFileReady()` during startup.
  - This creates `.agents/PLAN.md` if missing.
  - This also ensures `.agents/PLAN.md` is present in `.gitignore`.
- `.agents/PLAN.md` is intentionally excluded from upmerge.
  - `worktree.ts` hard-codes it in `UPMERGE_IGNORED_PATHS`.
- The `:agents-md` flow is read-only until final writeback.
  - `commands.ts` restricts the sub-agent to discovery tools plus `create_agents_context`, then writes the returned markdown to the repo root.
- Initial conversation/tool context is seeded automatically.
  - `lib/agent/constants.ts` defines startup tool seeds for `list_project_tree`, `read_file package.json`, and for AGENTS generation also `read_file AGENTS.md`.

## Preferred Patterns

- When adding or changing a tool, update both files:
  - `tools/<name>.md` for schema/docs
  - `tools/<name>.ts` for implementation
- Keep path handling explicit and rooted.
  - Reuse existing workspace/worktree helpers instead of ad hoc `path.resolve` logic.
- Preserve the current subsystem split inside `lib/agent/`.
  - UI, approvals, persistence, shell execution, streaming, commands, and summaries are already separated.
- Treat root `AGENTS.md` as additive system guidance.
  - `loadInitialSystemMessage()` appends root `AGENTS.md` content after `tools/system-prompt.md` when present.
- Keep generated workspace state in existing machine-managed locations rather than inventing new ones.

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

- After code changes, run: `pnpm exec tsc --noEmit`
- After tool changes, verify both sides of the contract still line up:
  - `tools/<name>.md` name matches filename
  - `tools/<name>.ts` exports `execute`
- If changing startup, config, or workspace state behavior, re-check:
  - `lib/agent/constants.ts`
  - `lib/agent/config-store.ts`
  - `worktree.ts`

## Sharp Edges

- `lib/llm.ts` only requires `OPENAI_API_BASE` and `OPENAI_API_KEY` for non-ollama models, but remote features like embeddings and remote model listing still depend on them.
- Worktree behavior is optimistic, not guaranteed.
  - The default note says a git worktree will be created on first edit when available.
  - Code should not assume direct writes or worktree isolation is always active.
- Startup commands may run inside the worktree session.
  - `.agents/shell.json` currently includes `startupCommands: ["pnpm i"]`.
- Always-approved shell commands are matched by exact command string.
  - Small text changes can bypass prior approvals.
- Skill indexing depends on embeddings and the generated `.agents/skills-index.json`; if embeddings are unavailable, `:index`/skill search flows may fail or be stale.

## Change Policy

- Do not invent new repo-level commands unless they are added to `package.json` or clearly supported by code/docs.
- Preserve machine-managed files and conventions:
  - `.agents/PLAN.md` is scratch space and should remain gitignored.
  - `.agents/shell.json` is managed as persisted shell approval/startup state.
  - `.agents/skills-index.json` is generated from local skills.
- Prefer small, subsystem-local edits over broad refactors unless the change clearly spans multiple modules.
- When editing tooling, keep the markdown contract and implementation synchronized.

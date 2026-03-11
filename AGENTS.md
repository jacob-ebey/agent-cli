# AGENTS.md

## Project Summary

- `agent-cli` is a terminal-based agentic coding assistant implemented in TypeScript and ESM.
- The runtime centers on `agent.ts`, which wires together the TUI, conversation state, tool loading, approvals, streaming, shell execution, and worktree support.
- The project loads tool definitions from `tools/*.md` and executes matching `tools/*.ts` modules.
- The app is designed to operate inside the current workspace and, when possible, isolate edits in an agent-managed git worktree.

## Standard Commands

- Install dependencies: `pnpm install`
- Start the app: `pnpm start`
- Typecheck: `pnpm typecheck`
- There are no additional build, lint, or test scripts declared in `package.json`.

## Repo Map

- `agent.ts`
  - Main entrypoint and app orchestrator.
- `worktree.ts`
  - Git worktree session management, baseline tracking, restore/upmerge helpers.
- `lib/llm.ts`
  - Model/provider integration, streaming, embeddings, model listing.
- `lib/skills-index.ts`
  - Skill discovery, markdown chunking, embeddings index generation/search.
- `lib/agent/`
  - Core app subsystems:
  - `commands.ts`: colon commands including `:agents-md`, `:index`, `:model`, `:plan`, `:summarize`
  - `config-store.ts`: persisted config, root `AGENTS.md` loading, `.agents/PLAN.md` bootstrap, shell approval persistence
  - `conversation-store.ts`: active/history conversation persistence
  - `approvals.ts`: tool/shell approval flow
  - `shell-runner.ts`, `shell-session.ts`: shell execution and transcript formatting
  - `streaming.ts`: single-turn LLM/tool streaming loop
  - `tools.ts`: tool definition parsing and loading from `tools/`
  - `view.ts`, `view-models.ts`, `menus.ts`, `input-controller.ts`: TUI behavior and menus
- `tools/`
  - Machine-readable tool docs (`*.md`) plus executable implementations (`*.ts`).
  - `system-prompt.md` is special: it is read as the base system prompt, not treated as a tool.
- `.agents/skills/`
  - Local skill packs with `SKILL.md` files and reference docs.
- `.agents/skills-index.json`
  - Generated embeddings index for skill search.
- `.agents/shell.json`
  - Machine-managed shell approval/startup config in the workspace.

## Important Invariants

- Tool definition filenames must match tool names exactly.
  - `lib/agent/tools.ts` enforces that `tools/foo.md` defines tool name `foo`, and that `tools/foo.ts` exports `execute`.
- `tools/system-prompt.md` is excluded from tool loading and is used as the base system prompt.
- Paths for workspace tools must stay inside the workspace root.
  - This constraint is explicitly enforced in worktree/path helpers and tool docs.
- `agent.ts` always calls `ensurePlanFileReady()` during startup.
  - This creates `.agents/PLAN.md` if missing.
  - This also ensures `.agents/PLAN.md` is listed in `.gitignore`.
- `.agents/PLAN.md` is intentionally ignored during upmerge.
  - `worktree.ts` hard-codes `.agents/PLAN.md` in `UPMERGE_IGNORED_PATHS`.
- The AGENTS.md generation flow is read-only until final output.
  - `:agents-md` uses a restricted tool set and expects exactly one `create_agents_context` result.

## Preferred Patterns

- Put user-facing tool schema/docs in `tools/*.md` and implementation in the matching `tools/*.ts` file.
- Keep path handling explicit and rooted.
  - Reuse existing workspace/worktree helpers instead of introducing ad hoc path resolution.
- Preserve the split between subsystems in `lib/agent/`.
  - UI, approvals, persistence, shell execution, streaming, and commands are already separated.
- Treat root `AGENTS.md` as additive system guidance.
  - `loadInitialSystemMessage()` appends workspace `AGENTS.md` contents to `tools/system-prompt.md` when present.

## Environment / Services

- Required at startup:
  - `OPENAI_API_BASE`
  - `OPENAI_API_KEY`
- Optional:
  - `OPENAI_EMBEDDING_MODEL` (defaults to `text-embedding-3-small`)
  - `OLLAMA_API_BASE` (defaults to `http://127.0.0.1:11434`)
- Model presets are declared in `lib/agent/constants.ts`:
  - `anthropic:claude-sonnet-4-6`
  - `openai:gpt-5.4`
  - `google:gemini-3.1-pro-preview`
  - `ollama:qwen3.5:latest`
- OpenAI-compatible model listing hits `/models`; Ollama model listing hits `/api/tags`.

## Persistence / Generated State

- Global config lives under the OS config dir for `agent-cli`:
  - Non-Windows: `~/.config/agent-cli/...` unless `XDG_CONFIG_HOME` is set
  - Windows: `%APPDATA%\agent-cli\...`
- Persisted files include:
  - `config.json` for current model
  - workspace-scoped active/previous conversation state
  - workspace-scoped conversation history
  - workspace-scoped worktree session state under the config dir
- Workspace-managed/generated files include:
  - `.agents/PLAN.md`
  - `.agents/shell.json`
  - `.agents/skills-index.json`

## Validation

- After code changes, run: `pnpm exec tsc --noEmit`
- After tool changes, also verify the doc/module pair stays aligned:
  - `tools/<name>.md` name matches filename
  - `tools/<name>.ts` exports `execute`
- If changing startup/config behavior, re-check assumptions in:
  - `lib/agent/constants.ts`
  - `lib/agent/config-store.ts`
  - `worktree.ts`

## Sharp Edges

- `package.json` declares `"start": "node cli.ts"`, but the visible repository entrypoint is `agent.ts` and no `cli.ts` is present in the shown tree. Treat this as a repo inconsistency to verify before changing startup behavior.
- `lib/llm.ts` throws immediately if `OPENAI_API_BASE` or `OPENAI_API_KEY` is missing, so even flows that do not use remote inference directly may fail during module initialization.
- Worktree behavior is optimistic but conditional.
  - The default note says a git worktree is created on first edit when available.
  - Code that assumes direct writes or guaranteed worktree isolation should be reviewed carefully.
- Always-approved shell commands are persisted by exact command string in `.agents/shell.json`.
  - Small command text changes can bypass previous approvals.

## Change Policy

- Do not invent new repo-level commands or workflows unless they are added to `package.json` or documented in code/docs.
- Preserve machine-managed files and conventions:
  - `.agents/PLAN.md` exists for scratch planning and should remain gitignored.
  - `.agents/shell.json` is managed as persisted approval/startup state.
  - `.agents/skills-index.json` is generated from local skills.
- Prefer small, subsystem-local edits over cross-cutting refactors unless the change clearly requires it.
- When editing tooling, update both the markdown contract and the implementation together.

# agent-cli

`agent-cli` is a terminal-based agentic coding assistant built with TypeScript and ESM.

It is designed for people who want an assistant that feels at home in a real codebase: one that can inspect files, reason across project structure, use local tools, work inside a git worktree, and stay transparent about what it is doing.

Unlike browser-first coding assistants, `agent-cli` keeps the conversation close to your shell, your repository, and your existing workflow. You can point it at remote OpenAI-compatible models, run it against local Ollama models, and extend it with tools and repo-specific guidance.

## Why try it?

- **Terminal-native workflow**: work where you already debug, grep, test, and commit.
- **Model flexibility**: use remote OpenAI-compatible backends or local Ollama models.
- **Tool-driven behavior**: file reads, structured search, shell execution, and patch application are first-class parts of the runtime.
- **Repo-aware guidance**: `AGENTS.md` and local skills let teams teach the assistant how the project works.
- **Safer editing loop**: edits can happen in an agent-managed git worktree, with approvals and merge flows built in.
- **Built for hacking**: the CLI itself is open source, small enough to understand, and straightforward to customize.

## Features

- Interactive terminal UI for chatting with an agent in the current workspace
- Support for OpenAI-compatible providers and local Ollama models
- Syntax-aware code search via `ast-grep` and fast text search via `ripgrep`
- Shell command execution with approval controls and persisted approvals
- Structured tool loading from `tools/*.md` plus TypeScript implementations
- Workspace-scoped conversation history and persisted configuration
- Local skill indexing for reusable implementation guidance
- Git worktree support for isolating edits before merging them back
- Session-scoped safety constraints for read-only, shell, network, max-file, and validation-aware workflows
- Critique and review commands for challenging plans and auditing the current session state
- Commands for model switching, planning, summarizing, indexing, constraints, critique, review, and worktree management

## How it differs from Claude Code / Codex

`agent-cli` sits in a similar category, but the emphasis is a bit different:

- **More hackable**: the codebase is intentionally approachable, so you can inspect how tools, prompts, approvals, and streaming actually work.
- **Bring your own models**: instead of tying you to a single hosted assistant, it works with OpenAI-compatible APIs and Ollama.
- **Repository conventions are explicit**: project guidance lives in files such as `AGENTS.md` and `.agents/skills/`, rather than being hidden in a service.
- **Local-first ergonomics**: it is comfortable in personal repos, experimental tools, and team workflows where shell access and local context matter.
- **Less product wrapper, more programmable assistant runtime**: if you want to adapt behavior, add tools, or understand the control flow, you can.

If you already use Claude Code or Codex, `agent-cli` may appeal if you want something more inspectable, more configurable, or easier to run against your own preferred model stack.

## Requirements

Install these tools before getting started:

- [Bun](https://bun.sh/)
- [ripgrep](https://github.com/BurntSushi/ripgrep)
- [ast-grep](https://ast-grep.github.io/)

Optional:

- [Ollama](https://ollama.com/) if you want to use a local Ollama model such as `ollama:qwen3.5:latest`

## Setup

1. Clone the repository.

```bash
git clone <repo-url>
cd agent-cli
```

2. Install dependencies.

```bash
bun install
```

3. Configure the runtime.

At minimum, set the environment variables for whichever model backends you plan to use.

### Environment variables

#### Remote OpenAI-compatible access

These are required if you want to use remote models such as the built-in `openai:*`, `anthropic:*`, or `google:*` presets through an OpenAI-compatible gateway.

```bash
export OPENAI_API_BASE="<your-openai-compatible-base-url>"
export OPENAI_API_KEY="<your-api-key>"
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENAI_API_BASE` | for remote models | Base URL for your OpenAI-compatible API. The CLI normalizes this automatically and will append `/v1` when needed. |
| `OPENAI_API_KEY` | for remote models | API key sent to the OpenAI-compatible provider. |
| `OPENAI_EMBEDDING_MODEL` | optional | Embedding model used for skills indexing and search. Defaults to `text-embedding-3-small`. |

Example:

```bash
export OPENAI_API_BASE="https://your-gateway.example.com"
export OPENAI_API_KEY="sk-..."
export OPENAI_EMBEDDING_MODEL="text-embedding-3-small"
```

Notes:

- Remote model access is unavailable unless both `OPENAI_API_BASE` and `OPENAI_API_KEY` are set.
- Model listing for remote providers also depends on these two variables.
- Skill indexing prefers the remote embedding backend when the OpenAI-compatible gateway is configured.

#### Local Ollama access

Ollama support works without the remote gateway variables.

```bash
export OLLAMA_API_BASE="http://127.0.0.1:11434"
export OLLAMA_EMBEDDING_MODEL="nomic-embed-text"
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `OLLAMA_API_BASE` | optional | Base URL for your Ollama server. Defaults to `http://127.0.0.1:11434`. |
| `OLLAMA_EMBEDDING_MODEL` | optional | Embedding model used when the CLI falls back to Ollama-backed embeddings. Defaults to `nomic-embed-text`. |

Notes:

- `OLLAMA_API_BASE` is only needed if your Ollama server is not running at the default local address.
- If the remote gateway is not configured, embeddings fall back to Ollama using `OLLAMA_EMBEDDING_MODEL`.

### Workspace config files

`agent-cli` keeps some state in workspace-managed files under `.agents/`.

#### `.agents/shell.json`

This file stores persisted shell command approvals and optional startup commands for the current workspace.

Location:

```text
.agents/shell.json
```

Supported shape:

```json
{
  "version": 1,
  "approvedCommands": [
    "bun typecheck",
    "bun test*"
  ],
  "startupCommands": [
    "pwd",
    "git status"
  ]
}
```

Fields:

- `version`: optional schema version written by the CLI. Current value is `1`.
- `approvedCommands`: optional list of commands that no longer need per-run approval.
- `startupCommands`: optional list of commands that may run automatically on startup.

Rules for command entries:

- Entries can be exact command strings such as `bun typecheck`.
- Entries can also use a single trailing `*` as a prefix wildcard, such as `bun test*`.
- Wildcards are only valid at the end of the string.
- Invalid patterns such as `*bun test`, `bun*test`, or `bun**` are ignored when the file is loaded.
- Empty strings and non-string values are ignored.

Behavior notes:

- `approvedCommands` affects shell approval prompts for `run-shell-command`.
- A trailing-`*` entry matches any command with that prefix. For example, `bun test*` matches `bun test` and `bun test test/event-stream-decoder.test.ts`.
- The CLI preserves `startupCommands` when it updates saved approvals.
- Startup commands may run inside the active agent-managed worktree when one exists.
- This file is workspace-local, so different repositories can have different approval policies.

When to edit it manually:

- Usually you do not need to. The CLI writes approvals here when a user chooses an “always allow” style approval.
- Manual edits are reasonable if you want to preseed approved commands or startup commands for a repo.

## Optional: install Ollama

If you want to use local models through Ollama:

1. Install Ollama from [ollama.com](https://ollama.com/).
2. Start the Ollama app or server.
3. Pull a model, for example:

```bash
ollama pull qwen3.5:latest
```

Then you can use an Ollama-backed model such as `ollama:qwen3.5:latest` in the CLI.

## Run the project

Start the CLI from the repository root:

```bash
bun run agent.ts
```

## Useful commands

Inside the TUI, some of the most useful commands are:

- `:model` to open the model picker
- `:plan` to inspect `.agents/PLAN.md`
- `:summarize` to compress the current conversation history
- `:constraints` to show the current session safety settings
- `:constraints read-only=true shell=deny` to tighten the session guardrails
- `:critique <idea>` to ask the agent to challenge a design or plan
- `:review` to review the current session state, pending changes, and validation status
- `:merge` / `:worktree` for worktree-oriented edit flows

### Session constraints

`agent-cli` can enforce session-scoped guardrails without requiring repo configuration.

Supported settings:

- `read-only=true|false`
- `shell=allow|ask|deny`
- `network=allow|ask|deny`
- `max-files=<number>`
- `require-validation=true|false`

Examples:

```text
:constraints
:constraints read-only=true
:constraints shell=deny network=deny
:constraints max-files=2 require-validation=true
:constraints reset
```

Notes:

- `shell=deny` blocks both tool-driven shell execution and manual shell commands entered through the TUI.
- `network=deny` blocks web fetch/search tools.
- `max-files` limits edits to a fixed number of unique files in the current session.
- validation freshness is tracked after edits and refreshed by `bun typecheck` or `bun test`.
- constraints are session-scoped in the current implementation.

## Convenience alias

If you want to launch the CLI from anywhere, add a shell alias that points at the repository's `agent.ts` file:

```bash
alias agent-cli='bun /path/to/repo/agent.ts'
```

Add that alias to your shell profile if you want it to persist.


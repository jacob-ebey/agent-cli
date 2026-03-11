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
- Commands for model switching, planning, summarizing, indexing, and worktree management

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

3. Set the required environment variables for remote OpenAI-compatible access.

```bash
export OPENAI_API_BASE="<your-openai-compatible-base-url>"
export OPENAI_API_KEY="<your-api-key>"
```

Optional environment variables:

```bash
export OPENAI_EMBEDDING_MODEL="text-embedding-3-small"
export OLLAMA_API_BASE="http://127.0.0.1:11434"
```

Notes:

- `OPENAI_API_BASE` and `OPENAI_API_KEY` are required for remote OpenAI-compatible models.
- `OPENAI_EMBEDDING_MODEL` controls the embedding model used for skill indexing and defaults to `text-embedding-3-small`.
- `OLLAMA_API_BASE` is only needed if your Ollama server is not running at the default local address.

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

## Convenience alias

If you want to launch the CLI from anywhere, add a shell alias that points at the repository's `agent.ts` file:

```bash
alias agent-cli='bun /path/to/repo/agent.ts'
```

Add that alias to your shell profile if you want it to persist.


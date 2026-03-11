# agent-cli

`agent-cli` is a terminal-based agentic coding assistant built with TypeScript and ESM.

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


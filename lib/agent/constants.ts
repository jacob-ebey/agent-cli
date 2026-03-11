import { homedir, tmpdir } from "node:os";
import * as path from "node:path";

import type { InitialToolMessageSeed } from "./types.ts";

export const WORKSPACE_ROOT = process.cwd();
export const TOOLS_DIRECTORY = "tools";
export const SYSTEM_PROMPT_PATH = path.join(TOOLS_DIRECTORY, "system-prompt.md");
export const ROOT_AGENTS_PATH = path.join(WORKSPACE_ROOT, "AGENTS.md");
export const MODEL_PRESETS = {
  anthropic: "anthropic:claude-sonnet-4-6",
  openai: "openai:gpt-5.4",
  google: "google:gemini-3.1-pro-preview",
  ollama: "ollama:qwen3:latest",
} as const;

export const CONFIG_DIRECTORY =
  process.platform === "win32"
    ? path.join(
        process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"),
        "agent-cli"
      )
    : path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"),
        "agent-cli"
      );

export const CONFIG_PATH = path.join(CONFIG_DIRECTORY, "config.json");

const WORKSPACE_STATE_DIRECTORY = path.join(
  CONFIG_DIRECTORY,
  "workspaces",
  Buffer.from(WORKSPACE_ROOT).toString("base64url")
);

export const ACTIVE_CONVERSATION_PATH = path.join(
  WORKSPACE_STATE_DIRECTORY,
  "active-conversation.json"
);
export const PREVIOUS_CONVERSATION_PATH = path.join(
  WORKSPACE_STATE_DIRECTORY,
  "previous-conversation.json"
);
export const CONVERSATION_HISTORY_DIRECTORY = path.join(
  WORKSPACE_STATE_DIRECTORY,
  "history"
);
export const CONVERSATION_WORKTREES_DIRECTORY = path.join(
  WORKSPACE_STATE_DIRECTORY,
  "worktrees"
);
export const SHELL_APPROVALS_PATH = path.join(
  WORKSPACE_ROOT,
  ".agents",
  "shell.json"
);
export const PLAN_PATH = path.join(WORKSPACE_ROOT, ".agents", "PLAN.md");
export const GITIGNORE_PATH = path.join(WORKSPACE_ROOT, ".gitignore");
export const PLAN_GITIGNORE_ENTRY = ".agents/PLAN.md";
export const INPUT_HISTORY_PATH = path.join(
  tmpdir(),
  "agent-cli-input-history.json"
);
export const INPUT_HISTORY_LIMIT = 100;
export const SHELL_OUTPUT_CHAR_LIMIT = 64_000;
export const LAUNCH_ARGUMENTS = new Set(process.argv.slice(2));
export const SHOULD_RECALL_PREVIOUS_SESSION =
  LAUNCH_ARGUMENTS.has("--recall") || LAUNCH_ARGUMENTS.has("--recal");
export const THINKING_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

export const INITIAL_TOOL_SEEDS: InitialToolMessageSeed[] = [
  {
    toolCallId: "initial-list-project-tree",
    toolName: "list_project_tree",
    input: {
      max_depth: 3,
    },
  },
  {
    toolCallId: "initial-read-file-package-json",
    toolName: "read_file",
    input: {
      path: "package.json",
    },
  },
];

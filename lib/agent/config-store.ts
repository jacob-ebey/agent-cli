import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  CONFIG_DIRECTORY,
  CONFIG_PATH,
  ROOT_AGENTS_PATH,
  SHELL_APPROVALS_PATH,
  SYSTEM_PROMPT_PATH,
} from "./constants.ts";
import type { PersistedConfig, PersistedShellApprovals } from "./types.ts";

function parsePersistedModel(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parsePersistedShellCommand(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const command = value.trim();
  if (!command) {
    return null;
  }

  const wildcardCount = [...command].filter((character) => character === "*").length;
  if (wildcardCount === 0) {
    return command;
  }

  return wildcardCount === 1 && command.endsWith("*") ? command : null;
}

export async function loadPersistedConfig(): Promise<PersistedConfig> {
  try {
    const source = await fs.readFile(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(source) as {
      currentModel?: unknown;
    };
    const currentModel = parsePersistedModel(parsed.currentModel);
    return currentModel ? { currentModel } : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }

    console.warn(`Failed to load agent config from ${CONFIG_PATH}:`, error);
    return {};
  }
}

export async function savePersistedConfig(config: PersistedConfig) {
  await fs.mkdir(CONFIG_DIRECTORY, { recursive: true });
  await fs.writeFile(
    CONFIG_PATH,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf-8"
  );
}

async function loadPersistedShellConfig() {
  try {
    const source = await fs.readFile(SHELL_APPROVALS_PATH, "utf-8");
    const parsed = JSON.parse(source) as {
      approvedCommands?: unknown;
      startupCommands?: unknown;
    };
    const approvedCommands = Array.isArray(parsed.approvedCommands)
      ? parsed.approvedCommands
          .map((entry) => parsePersistedShellCommand(entry))
          .filter((entry): entry is string => entry !== null)
      : [];
    const startupCommands = Array.isArray(parsed.startupCommands)
      ? parsed.startupCommands
          .map((entry) => parsePersistedShellCommand(entry))
          .filter((entry): entry is string => entry !== null)
      : [];

    return {
      approvedCommands: new Set(approvedCommands),
      startupCommands,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        approvedCommands: new Set<string>(),
        startupCommands: [],
      };
    }

    console.warn(
      `Failed to load shell config from ${SHELL_APPROVALS_PATH}:`,
      error
    );
    return {
      approvedCommands: new Set<string>(),
      startupCommands: [],
    };
  }
}

export async function loadPersistedShellApprovals() {
  const config = await loadPersistedShellConfig();
  return config.approvedCommands;
}

export async function savePersistedShellApprovals(approvedCommands: Set<string>) {
  const existingConfig = await loadPersistedShellConfig();
  const sortedApprovedCommands = [...approvedCommands].sort((left, right) =>
    left.localeCompare(right)
  );
  const payload: PersistedShellApprovals = {
    version: 1,
    ...(sortedApprovedCommands.length > 0
      ? { approvedCommands: sortedApprovedCommands }
      : {}),
    ...(existingConfig.startupCommands.length > 0
      ? { startupCommands: existingConfig.startupCommands }
      : {}),
  };

  await fs.mkdir(path.dirname(SHELL_APPROVALS_PATH), { recursive: true });
  await fs.writeFile(
    SHELL_APPROVALS_PATH,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf-8"
  );
}

export async function loadRootAgentsGuidance() {
  try {
    const source = await fs.readFile(ROOT_AGENTS_PATH, "utf-8");
    const trimmedSource = source.trim();
    if (!trimmedSource) {
      return null;
    }

    return [
      "Additional repository guidance from the workspace root `AGENTS.md` file:",
      "",
      "<AGENTS.md>",
      trimmedSource,
      "</AGENTS.md>",
    ].join("\n");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function loadShellApprovalGuidance() {
  const config = await loadPersistedShellConfig();
  const approvedCommands = [...config.approvedCommands].sort((left, right) =>
    left.localeCompare(right)
  );

  if (approvedCommands.length === 0) {
    return [
      "Additional shell approval guidance:",
      "",
      "- If workspace `.agents/shell.json` defines any approved shell commands, they are included in this prompt and may be used without asking again. A command ending with `*` is treated as a prefix pattern.",
      "- Any additional shell commands may still require user approval, so use them sparingly and only when necessary.",
    ].join("\n");
  }

  return [
    "Additional shell approval guidance from workspace `.agents/shell.json`:",
    "",
    "- The following shell commands are already approved and may be used without asking again. Entries ending with `*` match any command with that prefix:",
    ...approvedCommands.map((command) => `  - \`${command}\``),
    "- Any additional shell commands may still require user approval, so use them sparingly and only when necessary.",
  ].join("\n");
}

export async function loadInitialSystemMessage() {
  const [baseSystemPrompt, rootAgentsGuidance, shellApprovalGuidance] =
    await Promise.all([
      fs.readFile(SYSTEM_PROMPT_PATH, "utf-8"),
      loadRootAgentsGuidance(),
      loadShellApprovalGuidance(),
    ]);

  return [baseSystemPrompt, rootAgentsGuidance, shellApprovalGuidance]
    .filter((part) => part && part.trim())
    .join("\n\n");
}

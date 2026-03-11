import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  CONFIG_DIRECTORY,
  CONFIG_PATH,
  GITIGNORE_PATH,
  PLAN_GITIGNORE_ENTRY,
  PLAN_PATH,
  ROOT_AGENTS_PATH,
  SHELL_APPROVALS_PATH,
  SYSTEM_PROMPT_PATH,
} from "./constants.ts";
import type { PersistedConfig, PersistedShellApprovals } from "./types.ts";

function parsePersistedModel(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parsePersistedShellCommand(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

export async function ensurePlanFileReady() {
  await fs.mkdir(path.dirname(PLAN_PATH), { recursive: true });

  try {
    await fs.access(PLAN_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    await fs.writeFile(PLAN_PATH, "", "utf-8");
  }

  let gitignoreSource = "";

  try {
    gitignoreSource = await fs.readFile(GITIGNORE_PATH, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const existingEntries = new Set(
    gitignoreSource
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );

  if (existingEntries.has(PLAN_GITIGNORE_ENTRY)) {
    return;
  }

  const nextSource = gitignoreSource.trimEnd()
    ? `${gitignoreSource.trimEnd()}\n${PLAN_GITIGNORE_ENTRY}\n`
    : `${PLAN_GITIGNORE_ENTRY}\n`;

  await fs.writeFile(GITIGNORE_PATH, nextSource, "utf-8");
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

export async function loadInitialSystemMessage() {
  const [baseSystemPrompt, rootAgentsGuidance] = await Promise.all([
    fs.readFile(SYSTEM_PROMPT_PATH, "utf-8"),
    loadRootAgentsGuidance(),
  ]);

  return [baseSystemPrompt, rootAgentsGuidance]
    .filter((part) => part && part.trim())
    .join("\n\n");
}

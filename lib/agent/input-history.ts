import * as fs from "node:fs/promises";

import { INPUT_HISTORY_LIMIT, INPUT_HISTORY_PATH } from "./constants.ts";
import type { InputHistoryState } from "./types.ts";

export function emptyInputHistoryState(): InputHistoryState {
  return {
    version: 1,
    insert: [],
    command: [],
    shell: [],
    agent_shell: [],
  };
}

function parseHistoryEntries(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);

  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const entry of normalized) {
    if (seen.has(entry)) {
      continue;
    }

    seen.add(entry);
    deduped.push(entry);

    if (deduped.length >= INPUT_HISTORY_LIMIT) {
      break;
    }
  }

  return deduped;
}

export async function loadInputHistory(): Promise<InputHistoryState> {
  try {
    const source = await fs.readFile(INPUT_HISTORY_PATH, "utf-8");
    const parsed = JSON.parse(source) as Partial<Record<keyof InputHistoryState, unknown>>;

    return {
      version: 1,
      insert: parseHistoryEntries(parsed.insert),
      command: parseHistoryEntries(parsed.command),
      shell: parseHistoryEntries(parsed.shell),
      agent_shell: parseHistoryEntries(parsed.agent_shell),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyInputHistoryState();
    }

    console.warn(`Failed to load input history from ${INPUT_HISTORY_PATH}:`, error);
    return emptyInputHistoryState();
  }
}

export async function saveInputHistory(history: InputHistoryState) {
  await fs.writeFile(
    INPUT_HISTORY_PATH,
    `${JSON.stringify(history, null, 2)}\n`,
    "utf-8"
  );
}

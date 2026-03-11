import * as fs from "node:fs/promises";

import { INPUT_HISTORY_LIMIT, INPUT_HISTORY_PATH } from "./constants.ts";
import type { HistoryMode, InputHistoryState } from "./types.ts";

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

// agent_shell shares history with shell so commands run in either mode are
// visible when navigating history in the other.
export function historyKey(
  currentMode: HistoryMode
): Exclude<HistoryMode, "agent_shell"> {
  return currentMode === "agent_shell" ? "shell" : currentMode;
}

export function resetHistoryCursor(options: {
  currentMode: HistoryMode;
  inputHistory: InputHistoryState;
  historyCursor: Record<Exclude<HistoryMode, "agent_shell">, number>;
  historyDrafts: Record<Exclude<HistoryMode, "agent_shell">, string>;
}) {
  const key = historyKey(options.currentMode);
  options.historyCursor[key] = options.inputHistory[key].length;
  options.historyDrafts[key] = "";
}

export function recordHistoryEntry(options: {
  currentMode: HistoryMode;
  rawValue: string;
  inputHistory: InputHistoryState;
  historyCursor: Record<Exclude<HistoryMode, "agent_shell">, number>;
  historyDrafts: Record<Exclude<HistoryMode, "agent_shell">, string>;
}) {
  const value = options.rawValue.trim();
  if (!value) {
    resetHistoryCursor(options);
    return false;
  }

  const key = historyKey(options.currentMode);
  const entries = options.inputHistory[key].filter((entry) => entry !== value);
  entries.push(value);
  options.inputHistory[key] = entries.slice(-INPUT_HISTORY_LIMIT);
  resetHistoryCursor(options);
  return true;
}

export function syncHistoryDraft(options: {
  currentMode: HistoryMode;
  value: string;
  inputHistory: InputHistoryState;
  historyCursor: Record<Exclude<HistoryMode, "agent_shell">, number>;
  historyDrafts: Record<Exclude<HistoryMode, "agent_shell">, string>;
}) {
  const key = historyKey(options.currentMode);
  if (options.historyCursor[key] === options.inputHistory[key].length) {
    options.historyDrafts[key] = options.value;
  }
}

export function navigateHistory(options: {
  currentMode: HistoryMode;
  delta: -1 | 1;
  inputHistory: InputHistoryState;
  historyCursor: Record<Exclude<HistoryMode, "agent_shell">, number>;
  historyDrafts: Record<Exclude<HistoryMode, "agent_shell">, string>;
  currentDraftForMode: (currentMode: HistoryMode) => string;
  setDraftForMode: (currentMode: HistoryMode, value: string) => void;
}) {
  const key = historyKey(options.currentMode);
  const entries = options.inputHistory[key];
  if (!entries.length) {
    return null;
  }

  const nextCursor = Math.max(
    0,
    Math.min(entries.length, options.historyCursor[key] + options.delta)
  );

  if (nextCursor === options.historyCursor[key]) {
    return null;
  }

  if (options.historyCursor[key] === entries.length) {
    options.historyDrafts[key] = options.currentDraftForMode(options.currentMode);
  }

  options.historyCursor[key] = nextCursor;
  const nextValue =
    nextCursor === entries.length ? options.historyDrafts[key] : entries[nextCursor] ?? "";
  options.setDraftForMode(options.currentMode, nextValue);
  return nextValue;
}

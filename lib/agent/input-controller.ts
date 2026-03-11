import type { KeyEvent } from "@opentui/core";

import type { HistoryMode, InputHistoryState, Mode } from "./types.ts";
import {
  navigateHistory,
  recordHistoryEntry,
  saveInputHistory,
  syncHistoryDraft,
} from "./input-history.ts";

export function modeToHistoryMode(currentMode: Mode): HistoryMode | null {
  if (currentMode === "normal") {
    return null;
  }

  return currentMode;
}

export function isHistoryMode(currentMode: Mode): currentMode is HistoryMode {
  return currentMode !== "normal";
}

export function moveComposerCursorToEnd(options: {
  input: {
    plainText: string;
    handleKeyPress: (key: KeyEvent) => boolean;
  };
  value: string;
}) {
  const { input, value } = options;
  const desiredLength = value.length;

  process.nextTick(() => {
    const currentValue = input.plainText;
    const currentLength = currentValue.length;

    if (currentLength <= desiredLength) {
      return;
    }

    for (let index = 0; index < currentLength - desiredLength; index += 1) {
      input.handleKeyPress({
        name: "left",
        sequence: "",
        ctrl: false,
        meta: false,
        shift: false,
      } as KeyEvent);
    }
  });
}

export async function persistInputHistory(options: {
  inputHistory: InputHistoryState;
  inputHistoryPath: string;
}) {
  try {
    await saveInputHistory(options.inputHistory);
  } catch (error) {
    console.warn(`Failed to save input history to ${options.inputHistoryPath}:`, error);
  }
}

export async function recordAndPersistHistoryEntry(options: {
  currentMode: HistoryMode;
  rawValue: string;
  inputHistory: InputHistoryState;
  historyCursor: Record<HistoryMode, number>;
  historyDrafts: Record<HistoryMode, string>;
  inputHistoryPath: string;
}) {
  const changed = recordHistoryEntry({
    currentMode: options.currentMode,
    rawValue: options.rawValue,
    inputHistory: options.inputHistory,
    historyCursor: options.historyCursor,
    historyDrafts: options.historyDrafts,
  });

  if (changed) {
    await persistInputHistory({
      inputHistory: options.inputHistory,
      inputHistoryPath: options.inputHistoryPath,
    });
  }
}

export function navigateHistoryInComposer(options: {
  currentMode: HistoryMode;
  delta: -1 | 1;
  inputHistory: InputHistoryState;
  historyCursor: Record<HistoryMode, number>;
  historyDrafts: Record<HistoryMode, string>;
  currentDraftForMode: (mode: HistoryMode) => string;
  setDraftForMode: (mode: HistoryMode, value: string) => void;
  setComposerText: (value: string) => void;
  moveComposerCursorToEnd: (value: string) => void;
  updateComposerHint: () => void;
  requestRender: () => void;
}) {
  const nextValue = navigateHistory({
    currentMode: options.currentMode,
    delta: options.delta,
    inputHistory: options.inputHistory,
    historyCursor: options.historyCursor,
    historyDrafts: options.historyDrafts,
    currentDraftForMode: options.currentDraftForMode,
    setDraftForMode: options.setDraftForMode,
  });

  if (nextValue === null) {
    return false;
  }

  options.setComposerText(nextValue);
  options.moveComposerCursorToEnd(nextValue);
  options.updateComposerHint();
  options.requestRender();
  return true;
}

export function syncComposerDraft(options: {
  mode: Mode;
  value: string;
  setDraftForMode: (mode: HistoryMode, value: string) => void;
  inputHistory: InputHistoryState;
  historyCursor: Record<HistoryMode, number>;
  historyDrafts: Record<HistoryMode, string>;
}) {
  const currentMode = isHistoryMode(options.mode) ? options.mode : "insert";
  options.setDraftForMode(currentMode, options.value);
  syncHistoryDraft({
    currentMode,
    value: options.value,
    inputHistory: options.inputHistory,
    historyCursor: options.historyCursor,
    historyDrafts: options.historyDrafts,
  });
}

export function isColonKey(key: KeyEvent) {
  return key.sequence === ":" || (key.shift && key.name === ";");
}

export function isShellKey(key: KeyEvent) {
  return key.sequence === "!" || (key.shift && key.name === "1");
}

export function isAgentShellKey(key: KeyEvent) {
  return key.sequence === "@" || (key.shift && key.name === "2");
}

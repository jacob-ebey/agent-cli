import type { ConversationHistoryItem, ModelMenuItem, UpmergeMenuItem } from "./types.ts";
import { buildConversationPreview, formatConversationTimestamp } from "./utils.ts";
import { buildModelMenuContent, computeModelViewportTop, filterModelItems, moveModelSelection, normalizeModelSelection, selectedModelItem } from "./model-menu.ts";
import { getUpmergePreview, getUpmergeStatus, revertRelativePath, upmergeAll, upmergeRelativePath } from "../../worktree.ts";
import { listAvailableModels } from "../llm.ts";
import { loadConversationHistory } from "./conversation-store.ts";

export function currentUpmergeItems(upmergeItems: UpmergeMenuItem[]) {
  if (!upmergeItems.length) {
    return [];
  }

  return [{ label: "Upmerge all pending files", path: null }, ...upmergeItems];
}

export function selectedUpmergeItem(options: {
  upmergeItems: UpmergeMenuItem[];
  upmergeSelection: number;
}) {
  const items = currentUpmergeItems(options.upmergeItems);
  if (!items.length) {
    return null;
  }

  return items[Math.min(options.upmergeSelection, items.length - 1)] ?? null;
}

export async function refreshUpmergePreview(options: {
  upmergeMenuOpen: boolean;
  upmergeItems: UpmergeMenuItem[];
  upmergeSelection: number;
}) {
  if (!options.upmergeMenuOpen) {
    return null;
  }

  const selected = selectedUpmergeItem(options);
  return await getUpmergePreview(selected?.path ?? undefined);
}

export async function refreshUpmergeState(options: {
  upmergeMenuOpen: boolean;
  upmergeSelection: number;
}) {
  const status = await getUpmergeStatus();
  const upmergeItems = status.pendingFiles.map((entry) => ({
    label: entry,
    path: entry,
  }));

  const items = currentUpmergeItems(upmergeItems);
  let upmergeSelection = options.upmergeSelection;
  if (!items.length) {
    upmergeSelection = 0;
  } else if (upmergeSelection >= items.length) {
    upmergeSelection = items.length - 1;
  }

  return {
    upmergeMode: status.mode,
    upmergeNote: status.note,
    upmergeItems,
    upmergeSelection,
    preview: options.upmergeMenuOpen
      ? await refreshUpmergePreview({
          upmergeMenuOpen: true,
          upmergeItems,
          upmergeSelection,
        })
      : null,
  };
}

export async function runUpmergeSelection(options: {
  upmergeItems: UpmergeMenuItem[];
  upmergeSelection: number;
  action: "upmerge" | "revert";
}) {
  const selected = selectedUpmergeItem(options);
  if (!selected) {
    return { kind: "empty" as const };
  }

  if (options.action === "revert" && selected.path === null) {
    return { kind: "invalid-revert-all" as const };
  }

  const message =
    options.action === "upmerge"
      ? selected.path === null
        ? await upmergeAll()
        : await upmergeRelativePath(selected.path)
      : await revertRelativePath(selected.path!);

  return { kind: "ok" as const, message };
}

export function selectedHistoryItem(options: {
  historyItems: ConversationHistoryItem[];
  historySelection: number;
}) {
  if (!options.historyItems.length) {
    return null;
  }

  return options.historyItems[Math.min(options.historySelection, options.historyItems.length - 1)] ?? null;
}

export function buildHistoryPreview(options: {
  historyItems: ConversationHistoryItem[];
  historySelection: number;
}) {
  const selected = selectedHistoryItem(options);
  return selected
    ? [
        selected.title,
        "",
        `Saved: ${formatConversationTimestamp(selected.updatedAt)}`,
        `Started: ${formatConversationTimestamp(selected.createdAt)}`,
        "",
        buildConversationPreview(selected.transcript),
      ].join("\n")
    : "No saved conversations.";
}

export async function refreshHistoryState(options: {
  historyMenuOpen: boolean;
  historySelection: number;
}) {
  const historyItems = await loadConversationHistory();
  let historySelection = options.historySelection;

  if (!historyItems.length) {
    historySelection = 0;
  } else if (historySelection >= historyItems.length) {
    historySelection = historyItems.length - 1;
  }

  return {
    historyItems,
    historySelection,
    preview: options.historyMenuOpen
      ? buildHistoryPreview({ historyItems, historySelection })
      : null,
  };
}

export function selectedModelMenuItem(options: {
  filteredModelMenuItems: ModelMenuItem[];
  modelSelection: number;
}) {
  return selectedModelItem({
    filteredItems: options.filteredModelMenuItems,
    modelSelection: options.modelSelection,
  });
}

export function refreshFilteredModelItems(options: {
  modelMenuItems: ModelMenuItem[];
  modelFilter: string;
  modelSelection: number;
}) {
  const filteredModelMenuItems = filterModelItems(options.modelMenuItems, options.modelFilter);
  const modelSelection = normalizeModelSelection({
    filteredItems: filteredModelMenuItems,
    modelSelection: options.modelSelection,
  });

  return { filteredModelMenuItems, modelSelection };
}

export function buildModelMenuView(options: {
  currentModel: string;
  modelFilter: string;
  filteredModelMenuItems: ModelMenuItem[];
  modelMenuItems: ModelMenuItem[];
  modelSelection: number;
  modelMenuErrors: string[];
  note?: string;
  currentScrollTop: number;
  viewportHeight: number;
}) {
  const content = buildModelMenuContent({
    currentModel: options.currentModel,
    modelFilter: options.modelFilter,
    filteredItems: options.filteredModelMenuItems,
    allItems: options.modelMenuItems,
    modelSelection: options.modelSelection,
    modelMenuErrors: options.modelMenuErrors,
    note: options.note,
  }).join("\n");

  const scrollTop = computeModelViewportTop({
    currentScrollTop: options.currentScrollTop,
    viewportHeight: options.viewportHeight,
    modelSelection: options.modelSelection,
    filteredItems: options.filteredModelMenuItems,
  });

  return { content, scrollTop };
}

export async function loadModelMenuState() {
  const result = await listAvailableModels();
  return {
    modelMenuItems: result.models.map((model) => ({
      id: model.id,
      label: model.label,
      description: model.description,
      provider: model.provider,
    })),
    modelMenuErrors: result.errors,
  };
}

export function moveModelMenuSelection(options: {
  filteredModelMenuItems: ModelMenuItem[];
  modelSelection: number;
  delta: number;
}) {
  if (!options.filteredModelMenuItems.length) {
    return options.modelSelection;
  }

  return moveModelSelection({
    filteredItems: options.filteredModelMenuItems,
    modelSelection: options.modelSelection,
    delta: options.delta,
  });
}

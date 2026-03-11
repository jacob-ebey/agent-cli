import type {
  SidebarPresentationState,
  SidebarViewModel,
} from "./types.ts";
import { formatConversationTimestamp } from "./utils.ts";

function createApprovalSidebarViewModel(
  state: SidebarPresentationState,
  note: string
): SidebarViewModel {
  const approvalShortcuts =
    state.activeApproval?.approvalPersistence === "persisted"
      ? [
          "y      approve once",
          "a      always approve this command",
          "n/Esc  deny this command",
        ]
      : ["y      approve for session", "n/Esc  deny this edit"];

  return {
    title: "Approval",
    borderColor: "#f59e0b",
    content: [
      "Status: waiting",
      `Tool: ${state.activeApproval!.toolName}`,
      `${state.activeApproval!.displayLabel}: ${state.activeApproval!.displayValue}`,
      `Queued: ${state.queuedApprovalsCount}`,
      "",
      "Shortcuts",
      ...approvalShortcuts,
      "",
      note,
    ].join("\n"),
  };
}

function createUpmergeSidebarViewModel(
  state: SidebarPresentationState,
  note: string
): SidebarViewModel {
  const items = state.upmergeItems.length
    ? [{ label: "Upmerge all pending files", path: null }, ...state.upmergeItems]
    : [];

  return {
    title: "Upmerge",
    borderColor: "#22c55e",
    content: [
      `Edits: ${state.upmergeMode}`,
      `Pending: ${state.upmergeItems.length}`,
      "",
      items.length
        ? items
            .map(
              (item, index) => `${index === state.upmergeSelection ? ">" : " "} ${item.label}`
            )
            .join("\n")
        : "No pending upmerges.",
      "",
      "Shortcuts",
      "Enter  upmerge selected item",
      "r      revert selected file",
      "j / k  change selection",
      "u/Esc  close menu",
      "",
      note,
    ].join("\n"),
  };
}

function createHistorySidebarViewModel(
  state: SidebarPresentationState,
  note: string
): SidebarViewModel {
  return {
    title: "History",
    borderColor: "#38bdf8",
    content: [
      `Saved chats: ${state.historyItems.length}`,
      "",
      state.historyItems.length
        ? state.historyItems
            .map(
              (item, index) =>
                `${index === state.historySelection ? ">" : " "} ${item.title} (${formatConversationTimestamp(
                  item.updatedAt
                )})`
            )
            .join("\n")
        : "No saved conversations.",
      "",
      "Shortcuts",
      "Enter  load selected chat",
      "d      delete selected chat",
      "j / k  change selection",
      "Esc    close history",
      "",
      note,
    ].join("\n"),
  };
}

function createSessionSidebarViewModel(
  state: SidebarPresentationState,
  note: string
): SidebarViewModel {
  return {
    title: "Session",
    borderColor: "#334155",
    content: [
      `Status: ${state.busy ? "streaming" : "idle"}`,
      `Mode: ${state.mode}`,
      `Model: ${state.currentModel}`,
      `Messages: ${state.entriesCount}`,
      `Upmerges: ${state.upmergeItems.length}`,
      "",
      state.upmergeNote,
      "",
      note,
    ].join("\n"),
  };
}

export function createSidebarViewModel(
  state: SidebarPresentationState,
  note: string
): SidebarViewModel {
  if (state.activeApproval) {
    return createApprovalSidebarViewModel(state, note);
  }

  if (state.upmergeMenuOpen) {
    return createUpmergeSidebarViewModel(state, note);
  }

  if (state.historyMenuOpen) {
    return createHistorySidebarViewModel(state, note);
  }

  return createSessionSidebarViewModel(state, note);
}

export function createComposerHintContent(state: SidebarPresentationState) {
  if (state.activeApproval) {
    return state.activeApproval.approvalPersistence === "persisted"
      ? `Approval required. Press y to allow this command once, a to always allow this exact command, or n to deny.${
          state.queuedApprovalsCount
            ? ` ${state.queuedApprovalsCount} more approval request(s) are queued.`
            : ""
        }`
      : `Approval required. Press y to allow this file for the session, or n to deny.${
          state.queuedApprovalsCount
            ? ` ${state.queuedApprovalsCount} more approval request(s) are queued.`
            : ""
        }`;
  }

  if (state.upmergeMenuOpen) {
    return "Upmerge menu open. Enter upmerges the selection, r reverts a selected file, and u/Esc closes it.";
  }

  if (state.historyMenuOpen) {
    return "History browser open. Enter loads the selected conversation, d deletes it, and Esc closes the browser.";
  }

  if (state.modelMenuOpen) {
    return "Model picker open. Use j/k to move, . to filter, Enter to select, Backspace to edit the filter, and Esc to close.";
  }

  if (state.busy) {
    return state.activeShellProcess
      ? state.autoScrollState === "paused"
        ? "A shell command is running. Auto-scroll is paused while you audit earlier output. Press G to jump back to the live bottom, or Ctrl+C to stop it."
        : "A shell command is running. Press Ctrl+C to stop it, or use j and k to inspect earlier messages."
      : state.autoScrollState === "paused"
        ? "The agent is responding. Auto-scroll is paused while you audit earlier output. Press G to jump back to the live bottom, or Ctrl+C to abort."
        : "The agent is responding. Press Ctrl+C to abort, or use j and k to inspect earlier messages.";
  }

  if (state.mode === "normal") {
    return "Normal mode. Press i to compose, : for commands, !/@ for shell, u for upmerge, or j/k to scroll.";
  }

  if (state.mode === "command") {
    return "Command mode. Run :help, :clear, :history, :index, :model, :plan, :summarize, or :quit, or press Esc to return to normal.";
  }

  if (state.mode === "shell") {
    return "Shell mode. Press Enter to run a local shell command that stays hidden from the agent.";
  }

  if (state.mode === "agent_shell") {
    return "Agent shell mode. Press Enter to run a shell command and add its command and output to the agent conversation.";
  }

  if (!state.insertDraft.trim()) {
    return "Insert mode. Press Enter to send or Shift+Enter to insert a new line.";
  }

  return `Ready to send ${state.insertDraft.trim().length} characters.`;
}

import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  TextareaRenderable,
  createCliRenderer,
  type KeyEvent,
} from "@opentui/core";

import {
  listAvailableModels,
  streamResponse,
  type Message,
  type ResponseChunk,
  type Tool,
} from "./lib/llm.ts";
import {
  ACTIVE_CONVERSATION_PATH,
  CONVERSATION_WORKTREES_DIRECTORY,
  INPUT_HISTORY_LIMIT,
  INPUT_HISTORY_PATH,
  MODEL_PRESETS,
  THINKING_FRAMES,
  WORKSPACE_ROOT,
} from "./lib/agent/constants.ts";
import type {
  ApprovalDecision,
  ApprovalPersistence,
  ApprovalScope,
  AutoScrollState,
  ChatEntry,
  ChatRole,
  ConversationHistoryItem,
  ConversationMessage,
  DetailPanel,
  HistoryMode,
  InitialToolMessageSeed,
  InputHistoryState,
  LoadedTool,
  Mode,
  ModelMenuItem,
  ModelPresetName,
  PendingApproval,
  PersistedConfig,
  PersistedConversationState,
  PersistedShellApprovals,
  PersistedTranscriptEntry,
  ShellExecutionResult,
  ShellVisibility,
  ToolDefinition,
  ToolExecutor,
  ToolMetadata,
  UpmergeMenuItem,
} from "./lib/agent/types.ts";
import {
  appendChunkWithLimit,
  buildConversationPreview,
  extractAssistantText,
  formatConversationTimestamp,
  formatToolOutput,
  isRecord,
  lastAssistantResponseContainsToolCall,
  readStringArgument,
} from "./lib/agent/utils.ts";
import {
  ensurePlanFileReady,
  loadInitialSystemMessage,
  loadPersistedConfig,
  loadPersistedShellApprovals,
  savePersistedConfig,
  savePersistedShellApprovals,
} from "./lib/agent/config-store.ts";
import {
  createInitialConversationState,
  isMeaningfulConversationState,
  loadConversationHistory,
  resolveInitialConversationState,
  saveConversationStateToHistory,
  savePersistedConversationState,
  summarizeConversationTitleFromTranscript,
} from "./lib/agent/conversation-store.ts";
import { loadInputHistory, saveInputHistory } from "./lib/agent/input-history.ts";
import {
  clearApprovalQueueState,
  currentApprovalPrompt,
  ensureToolApproval,
  settleApprovalDecision,
  shiftNextPendingApproval,
} from "./lib/agent/approvals.ts";
import { runShellCommandSession } from "./lib/agent/shell-runner.ts";
import {
  loadInitialToolMessages,
  loadTools,
  summarizeToolResult,
} from "./lib/agent/tools.ts";
import { indexSkills } from "./lib/skills-index.ts";
import {
  captureWorkspaceSession,
  cleanupWorkspaceSession,
  getUpmergePreview,
  getUpmergeStatus,
  prepareWorkspaceForEdit,
  relativeOriginalWorkspacePath,
  revertRelativePath,
  restoreWorkspaceSession,
  resolveOriginalWorkspacePath,
  setWorkspaceSessionStorageRoot,
  upmergeAll,
  upmergeRelativePath,
  type PersistedWorkspaceSession,
} from "./worktree.ts";


function createInitialConversationMessages(): ConversationMessage[] {
  return [
    {
      role: "system",
      content: initialSystemMessage,
    },
    ...initialToolMessages,
  ];
}


await ensurePlanFileReady();

const [initialSystemMessage, loadedTools] = await Promise.all([
  loadInitialSystemMessage(),
  loadTools(),
]);
const initialToolMessages = await loadInitialToolMessages(loadedTools);

const [persistedConfig, approvedShellCommands, persistedInputHistory] =
  await Promise.all([
    loadPersistedConfig(),
    loadPersistedShellApprovals(),
    loadInputHistory(),
  ]);
const initialConversationState = await resolveInitialConversationState(
  createInitialConversationMessages()
);
const tools = Array.from(loadedTools.values(), (tool) => ({
  name: tool.definition.name,
  description: tool.definition.description,
  inputSchema: tool.definition.inputSchema,
  execute: async (input: unknown) => {
    const parsedArguments = isRecord(input) ? input : {};

    try {
      await ensureToolApproval(tool.definition.name, tool, parsedArguments, {
        approvedEditTargets,
        approvedShellCommands,
        enqueueApproval,
      });
      return await tool.execute(parsedArguments);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Tool execution failed: ${message}`;
    }
  },
}));

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
});

renderer.setBackgroundColor("#0b1020");

const conversation: ConversationMessage[] = [
  ...initialConversationState.conversation,
];
const transcriptHistory: PersistedTranscriptEntry[] = [
  ...initialConversationState.transcript,
];
let activeConversationId = initialConversationState.id;
let activeConversationCreatedAt = initialConversationState.createdAt;
configureConversationWorkspace(activeConversationId);
restoreWorkspaceSession(initialConversationState.workspaceSession);

let nextIdCounter = 0;
let busy = false;
let mode: Mode = "normal";
let insertDraft = "";
let commandDraft = "";
let shellDraft = "";
let agentShellDraft = "";
const inputHistory: InputHistoryState = {
  version: 1,
  insert: [...persistedInputHistory.insert],
  command: [...persistedInputHistory.command],
  shell: [...persistedInputHistory.shell],
  agent_shell: [...persistedInputHistory.agent_shell],
};
const historyCursor: Record<HistoryMode, number> = {
  insert: inputHistory.insert.length,
  command: inputHistory.command.length,
  shell: inputHistory.shell.length,
  agent_shell: inputHistory.agent_shell.length,
};
const historyDrafts: Record<HistoryMode, string> = {
  insert: "",
  command: "",
  shell: "",
  agent_shell: "",
};
const entries: ChatEntry[] = [];
let upmergeMode: "direct" | "worktree" = "direct";
let upmergeNote =
  "A git worktree will be created on the first edit when available.";
let upmergeItems: UpmergeMenuItem[] = [];
let upmergeMenuOpen = false;
let upmergeSelection = 0;
let historyMenuOpen = false;
let historyItems: ConversationHistoryItem[] = [];
let historySelection = 0;
let modelMenuOpen = false;
let modelMenuItems: ModelMenuItem[] = [];
let filteredModelMenuItems: ModelMenuItem[] = [];
let modelSelection = 0;
let modelFilter = "";
let modelMenuErrors: string[] = [];
let detailPanelAttached: DetailPanel = null;
let activeStreamAbortController: AbortController | null = null;
let activeShellProcess: ChildProcess | null = null;
let activeThinkingIndicator: NodeJS.Timeout | null = null;
let thinkingFrameIndex = 0;
let latestSidebarNote = "Ready for your next prompt.";
const approvedEditTargets = new Set<string>();
let activeApproval: PendingApproval | null = null;
const queuedApprovals: PendingApproval[] = [];
let autoScrollState: AutoScrollState = "follow";
let currentModel: string =
  persistedConfig.currentModel ?? MODEL_PRESETS.anthropic;

function announceActiveApproval() {
  if (!activeApproval) {
    return;
  }

  appendSystemMessage(
    [
      `Approval required before \`${activeApproval.toolName}\` can access ${activeApproval.displayLabel.toLowerCase()} \`${activeApproval.displayValue}\`.`,
      "",
      currentApprovalPrompt(activeApproval),
      queuedApprovals.length
        ? `${queuedApprovals.length} more approval request(s) are queued behind this one.`
        : null,
    ]
      .filter(Boolean)
      .join("\n")
  );
  updateSidebar(
    `Waiting for approval for ${activeApproval.displayLabel.toLowerCase()} ${activeApproval.displayValue}.`
  );
  updateComposerHint();
  renderer.requestRender();
}

function activateNextApproval() {
  activeApproval = shiftNextPendingApproval({
    activeApproval,
    queuedApprovals,
    approvedEditTargets,
    approvedShellCommands,
  });

  if (activeApproval) {
    announceActiveApproval();
    return;
  }

  updateSidebar();
  updateComposerHint();
  renderer.requestRender();
}

function enqueueApproval(request: PendingApproval) {
  if (!activeApproval) {
    activeApproval = request;
    announceActiveApproval();
    return;
  }

  queuedApprovals.push(request);
  updateSidebar(
    `Queued approval for ${request.displayLabel.toLowerCase()} ${request.displayValue}.`
  );
  updateComposerHint();
  renderer.requestRender();
}

function clearApprovalQueue() {
  clearApprovalQueueState({
    activeApproval,
    queuedApprovals,
  });
  activeApproval = null;
}

function updateTranscriptTitle() {
  transcriptPanel.title = busy ? "Conversation [...]" : "Conversation";
}

function stopThinkingIndicator() {
  if (activeThinkingIndicator) {
    clearInterval(activeThinkingIndicator);
    activeThinkingIndicator = null;
  }
  thinkingFrameIndex = 0;
}

function startThinkingIndicator(baseNote = latestSidebarNote) {
  latestSidebarNote = baseNote;
  if (activeThinkingIndicator) {
    return;
  }

  thinkingFrameIndex = 0;
  updateSidebar(baseNote);
  renderer.requestRender();

  activeThinkingIndicator = setInterval(() => {
    thinkingFrameIndex = (thinkingFrameIndex + 1) % THINKING_FRAMES.length;
    updateSidebar(baseNote);
    renderer.requestRender();
  }, 80);
}

function hasMeaningfulTranscript() {
  return transcriptHistory.some(
    (entry) =>
      entry.role === "user" || entry.role === "assistant" || entry.role === "error"
  );
}

function configureConversationWorkspace(conversationId: string) {
  setWorkspaceSessionStorageRoot(
    path.join(CONVERSATION_WORKTREES_DIRECTORY, conversationId)
  );
}

function serializeCurrentConversationState(): PersistedConversationState {
  const updatedAt = new Date().toISOString();
  return {
    version: 1,
    id: activeConversationId,
    title: summarizeConversationTitleFromTranscript(transcriptHistory),
    createdAt: activeConversationCreatedAt,
    updatedAt,
    workspaceSession: captureWorkspaceSession(),
    conversation: structuredClone(conversation),
    transcript: structuredClone(transcriptHistory),
  };
}

async function persistActiveConversation() {
  try {
    await savePersistedConversationState(
      ACTIVE_CONVERSATION_PATH,
      serializeCurrentConversationState()
    );
  } catch (error) {
    console.warn(
      `Failed to save active conversation to ${ACTIVE_CONVERSATION_PATH}:`,
      error
    );
  }
}

async function archiveCurrentConversation() {
  if (!hasMeaningfulTranscript() && captureWorkspaceSession() === null) {
    return false;
  }

  const state = serializeCurrentConversationState();
  try {
    await saveConversationStateToHistory(state);
    return true;
  } catch (error) {
    console.warn("Failed to archive conversation history:", error);
    return false;
  }
}

function setBusy(nextBusy: boolean) {
  busy = nextBusy;
  if (!busy) {
    stopThinkingIndicator();
  }
  updateTranscriptTitle();
}

class ComposerTextarea extends TextareaRenderable {
  handleKeyPress(key: KeyEvent): boolean {
    if (key.name === "enter" || key.name === "return") {
      if (mode === "insert" && key.shift) {
        return this.newLine();
      }

      return this.submit();
    }

    return super.handleKeyPress(key);
  }
}

function nextId(prefix: string) {
  nextIdCounter += 1;
  return `${prefix}-${nextIdCounter}`;
}

function describeModelOptions() {
  const presetLines = (
    Object.entries(MODEL_PRESETS) as Array<[ModelPresetName, string]>
  ).map(([name, modelId]) => `:model ${name.padEnd(10, " ")} ${modelId}`);

  return [
    `Current model: \`${currentModel}\``,
    "",
    "Presets",
    ...presetLines,
    "",
    "You can also run `:model your-model-id` to set any Shopify gateway model directly.",
    "Use `:model ollama:your-local-model` to target a local Ollama model.",
  ].join("\n");
}

function formatShellMessage({
  command,
  cwdLabel,
  stdout,
  stderr,
  exitCode,
  signal,
  startupError,
  stdoutTruncated,
  stderrTruncated,
  running,
  visibility,
}: {
  command: string;
  cwdLabel: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startupError: string | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  running: boolean;
  visibility: ShellVisibility;
}) {
  const summaryLine = running
    ? "Status: running"
    : startupError
      ? "Status: failed to start"
      : signal
        ? `Status: terminated by ${signal}`
        : `Status: exited with code ${exitCode ?? 0}`;
  const visibilityLine =
    visibility === "agent"
      ? "Visibility: shared with the agent in conversation history"
      : "Visibility: local only; hidden from the agent";

  return [
    "Shell command",
    command,
    "",
    `Cwd: ${cwdLabel}`,
    visibilityLine,
    summaryLine,
    !running && !startupError && signal === null
      ? `Exit code: ${exitCode ?? 0}`
      : null,
    startupError ? `Startup error: ${startupError}` : null,
    "",
    "Stdout:",
    stdout.length ? stdout : "(empty)",
    stdoutTruncated ? "\n[stdout truncated]\n" : null,
    "",
    "Stderr:",
    stderr.length ? stderr : "(empty)",
    stderrTruncated ? "\n[stderr truncated]\n" : null,
  ]
    .filter((part): part is string => part !== null)
    .join("\n");
}

function resolveModelCommand(input: string) {
  const value = input.trim();
  if (!value) {
    return null;
  }

  if (value in MODEL_PRESETS) {
    return MODEL_PRESETS[value as ModelPresetName];
  }

  return value || null;
}

function roleTheme(role: ChatRole) {
  switch (role) {
    case "user":
      return {
        title: "You",
        border: "#3b82f6",
        background: "#0f172a",
        foreground: "#dbeafe",
      };
    case "system":
      return {
        title: "System",
        border: "#8b5cf6",
        background: "#1e1b4b",
        foreground: "#ede9fe",
      };
    case "error":
      return {
        title: "Error",
        border: "#ef4444",
        background: "#2b1120",
        foreground: "#fecaca",
      };
    case "assistant":
    default:
      return {
        title: "Agent",
        border: "#10b981",
        background: "#052e2b",
        foreground: "#d1fae5",
      };
  }
}

const app = new BoxRenderable(renderer, {
  id: "app",
  width: "100%",
  height: "100%",
  flexDirection: "column",
  backgroundColor: "#0b1020",
  padding: 1,
  gap: 1,
});

const main = new BoxRenderable(renderer, {
  id: "main",
  flexGrow: 1,
  flexDirection: "row",
  gap: 1,
});

const transcriptPanel = new BoxRenderable(renderer, {
  id: "transcript-panel",
  flexGrow: 1,
  border: true,
  borderStyle: "rounded",
  borderColor: "#334155",
  backgroundColor: "#111827",
  title: "Conversation",
  padding: 1,
});

const transcript = new ScrollBoxRenderable(renderer, {
  id: "transcript",
  width: "100%",
  height: "100%",
  stickyScroll: true,
  stickyStart: "bottom",
  viewportOptions: {
    backgroundColor: "#111827",
  },
  contentOptions: {
    flexDirection: "column",
    gap: 1,
    backgroundColor: "#111827",
  },
  scrollbarOptions: {
    trackOptions: {
      foregroundColor: "#64748b",
      backgroundColor: "#1f2937",
    },
  },
});

transcriptPanel.add(transcript);

const sidebar = new BoxRenderable(renderer, {
  id: "sidebar",
  width: 32,
  border: true,
  borderStyle: "rounded",
  borderColor: "#334155",
  backgroundColor: "#0f172a",
  title: "Session",
  padding: 1,
});

const sidebarText = new TextRenderable(renderer, {
  id: "sidebar-text",
  content: "",
  fg: "#bfdbfe",
});

sidebar.add(sidebarText);

const upmergePanel = new BoxRenderable(renderer, {
  id: "upmerge-panel",
  width: 72,
  border: true,
  borderStyle: "rounded",
  borderColor: "#22c55e",
  backgroundColor: "#052e2b",
  title: "Upmerge Diff",
  padding: 1,
});

const upmergePreview = new ScrollBoxRenderable(renderer, {
  id: "upmerge-preview",
  width: "100%",
  height: "100%",
  stickyScroll: false,
  viewportOptions: {
    backgroundColor: "#052e2b",
  },
  contentOptions: {
    flexDirection: "column",
    backgroundColor: "#052e2b",
  },
});

const upmergePreviewText = new TextRenderable(renderer, {
  id: "upmerge-preview-text",
  content: "No pending upmerges.",
  fg: "#dcfce7",
});

upmergePreview.add(upmergePreviewText);
upmergePanel.add(upmergePreview);

const historyPanel = new BoxRenderable(renderer, {
  id: "history-panel",
  width: 72,
  border: true,
  borderStyle: "rounded",
  borderColor: "#38bdf8",
  backgroundColor: "#082f49",
  title: "Conversation History",
  padding: 1,
});

const historyPreview = new ScrollBoxRenderable(renderer, {
  id: "history-preview",
  width: "100%",
  height: "100%",
  stickyScroll: false,
  viewportOptions: {
    backgroundColor: "#082f49",
  },
  contentOptions: {
    flexDirection: "column",
    backgroundColor: "#082f49",
  },
});

const historyPreviewText = new TextRenderable(renderer, {
  id: "history-preview-text",
  content: "No saved conversations.",
  fg: "#e0f2fe",
});

historyPreview.add(historyPreviewText);
historyPanel.add(historyPreview);

const modelPanel = new BoxRenderable(renderer, {
  id: "model-panel",
  width: 72,
  border: true,
  borderStyle: "rounded",
  borderColor: "#f59e0b",
  backgroundColor: "#1c1917",
  title: "Model Picker",
  padding: 1,
});

const modelPreview = new ScrollBoxRenderable(renderer, {
  id: "model-preview",
  width: "100%",
  height: "100%",
  stickyScroll: false,
  viewportOptions: {
    backgroundColor: "#1c1917",
  },
  contentOptions: {
    flexDirection: "column",
    backgroundColor: "#1c1917",
  },
});

const modelPreviewText = new TextRenderable(renderer, {
  id: "model-preview-text",
  content: "Loading available models...",
  fg: "#fde68a",
});

modelPreview.add(modelPreviewText);
modelPanel.add(modelPreview);

main.add(transcriptPanel);
main.add(sidebar);

const composer = new BoxRenderable(renderer, {
  id: "composer",
  border: true,
  borderStyle: "rounded",
  borderColor: "#334155",
  backgroundColor: "#111827",
  title: "Compose",
  padding: 1,
  flexDirection: "column",
  gap: 1,
});

const input = new ComposerTextarea(renderer, {
  id: "composer-input",
  width: "100%",
  height: 4,
  placeholder: "Type a message and press Enter",
  backgroundColor: "#0f172a",
  focusedBackgroundColor: "#172554",
  textColor: "#e5e7eb",
  cursorColor: "#60a5fa",
  placeholderColor: "#64748b",
  wrapMode: "word",
});

const composerHint = new TextRenderable(renderer, {
  id: "composer-hint",
  content: "",
  fg: "#94a3b8",
});

composer.add(input);
composer.add(composerHint);

app.add(main);
app.add(composer);
renderer.root.add(app);

function setComposerText(value: string) {
  input.setText(value);
}

function modeToHistoryMode(currentMode: Mode): HistoryMode | null {
  if (currentMode === "normal") {
    return null;
  }

  return currentMode;
}

function currentDraftForMode(currentMode: HistoryMode) {
  if (currentMode === "command") {
    return commandDraft;
  }

  if (currentMode === "shell") {
    return shellDraft;
  }

  if (currentMode === "agent_shell") {
    return agentShellDraft;
  }

  return insertDraft;
}

function setDraftForMode(currentMode: HistoryMode, value: string) {
  if (currentMode === "command") {
    commandDraft = value;
    return;
  }

  if (currentMode === "shell") {
    shellDraft = value;
    return;
  }

  if (currentMode === "agent_shell") {
    agentShellDraft = value;
    return;
  }

  insertDraft = value;
}

async function persistInputHistory() {
  try {
    await saveInputHistory(inputHistory);
  } catch (error) {
    console.warn(`Failed to save input history to ${INPUT_HISTORY_PATH}:`, error);
  }
}

// agent_shell shares history with shell so commands run in either mode are
// visible when navigating history in the other.
function historyKey(currentMode: HistoryMode): Exclude<HistoryMode, "agent_shell"> {
  return currentMode === "agent_shell" ? "shell" : currentMode;
}

function resetHistoryCursor(currentMode: HistoryMode) {
  const key = historyKey(currentMode);
  historyCursor[key] = inputHistory[key].length;
  historyDrafts[key] = "";
}

async function recordHistoryEntry(currentMode: HistoryMode, rawValue: string) {
  const value = rawValue.trim();
  if (!value) {
    resetHistoryCursor(currentMode);
    return;
  }

  const key = historyKey(currentMode);
  const entries = inputHistory[key].filter((entry) => entry !== value);
  entries.push(value);
  inputHistory[key] = entries.slice(-INPUT_HISTORY_LIMIT);
  resetHistoryCursor(currentMode);
  await persistInputHistory();
}

function syncHistoryDraft(currentMode: HistoryMode, value: string) {
  const key = historyKey(currentMode);
  if (historyCursor[key] === inputHistory[key].length) {
    historyDrafts[key] = value;
  }
}

function navigateHistory(currentMode: HistoryMode, delta: -1 | 1) {
  const key = historyKey(currentMode);
  const entries = inputHistory[key];
  if (!entries.length) {
    return false;
  }

  const nextCursor = Math.max(
    0,
    Math.min(entries.length, historyCursor[key] + delta)
  );

  if (nextCursor === historyCursor[key]) {
    return false;
  }

  if (historyCursor[key] === entries.length) {
    historyDrafts[key] = currentDraftForMode(currentMode);
  }

  historyCursor[key] = nextCursor;
  const nextValue =
    nextCursor === entries.length ? historyDrafts[key] : entries[nextCursor] ?? "";
  setDraftForMode(currentMode, nextValue);
  setComposerText(nextValue);
  moveComposerCursorToEnd(nextValue);
  updateComposerHint();
  renderer.requestRender();
  return true;
}

function moveComposerCursorToEnd(value: string) {
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

function currentUpmergeItems() {
  if (!upmergeItems.length) {
    return [];
  }

  return [{ label: "Upmerge all pending files", path: null }, ...upmergeItems];
}

function selectedUpmergeItem() {
  const items = currentUpmergeItems();
  if (!items.length) {
    return null;
  }

  return items[Math.min(upmergeSelection, items.length - 1)] ?? null;
}

async function refreshUpmergePreview() {
  if (!upmergeMenuOpen) {
    return;
  }

  const selected = selectedUpmergeItem();
  upmergePreviewText.content = await getUpmergePreview(
    selected?.path ?? undefined
  );
  renderer.requestRender();
}

async function refreshUpmergeState() {
  const status = await getUpmergeStatus();
  upmergeMode = status.mode;
  upmergeNote = status.note;
  upmergeItems = status.pendingFiles.map((entry) => ({
    label: entry,
    path: entry,
  }));

  const items = currentUpmergeItems();
  if (!items.length) {
    upmergeSelection = 0;
  } else if (upmergeSelection >= items.length) {
    upmergeSelection = items.length - 1;
  }

  if (upmergeMenuOpen) {
    await refreshUpmergePreview();
  }

  updateSidebar();
  updateComposerHint();
  renderer.requestRender();
}

function attachDetailPanel(kind: Exclude<DetailPanel, null>) {
  if (detailPanelAttached === kind) {
    return;
  }

  if (detailPanelAttached === "upmerge") {
    main.remove(upmergePanel.id);
  } else if (detailPanelAttached === "history") {
    main.remove(historyPanel.id);
  } else if (detailPanelAttached === "model") {
    main.remove(modelPanel.id);
  }

  main.remove(sidebar.id);
  main.add(
    kind === "upmerge"
      ? upmergePanel
      : kind === "history"
        ? historyPanel
        : modelPanel
  );
  main.add(sidebar);
  detailPanelAttached = kind;
}

function detachDetailPanel(kind: Exclude<DetailPanel, null>) {
  if (detailPanelAttached !== kind) {
    return;
  }

  main.remove(
    kind === "upmerge"
      ? upmergePanel.id
      : kind === "history"
        ? historyPanel.id
        : modelPanel.id
  );
  detailPanelAttached = null;
}

function closeUpmergeMenu() {
  if (!upmergeMenuOpen) {
    return;
  }

  upmergeMenuOpen = false;
  detachDetailPanel("upmerge");
  updateSidebar();
  updateComposerHint();
  renderer.requestRender();
}

async function openUpmergeMenu() {
  closeHistoryMenu();
  closeModelMenu();
  upmergeMenuOpen = true;
  attachDetailPanel("upmerge");
  await refreshUpmergeState();
}

async function moveUpmergeSelection(delta: number) {
  const items = currentUpmergeItems();
  if (!items.length) {
    return;
  }

  upmergeSelection = (upmergeSelection + delta + items.length) % items.length;
  await refreshUpmergePreview();
  updateSidebar();
}

async function runUpmergeSelection(action: "upmerge" | "revert") {
  const selected = selectedUpmergeItem();
  if (!selected) {
    updateSidebar("No pending upmerges.");
    renderer.requestRender();
    return;
  }

  if (action === "revert" && selected.path === null) {
    updateSidebar("Select a file to revert it.");
    renderer.requestRender();
    return;
  }

  try {
    const message =
      action === "upmerge"
        ? selected.path === null
          ? await upmergeAll()
          : await upmergeRelativePath(selected.path)
        : await revertRelativePath(selected.path!);
    appendSystemMessage(message);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendEntry("error", message);
  }

  await refreshUpmergeState();
}

function selectedHistoryItem() {
  if (!historyItems.length) {
    return null;
  }

  return historyItems[Math.min(historySelection, historyItems.length - 1)] ?? null;
}

async function refreshHistoryPreview() {
  const selected = selectedHistoryItem();
  historyPreviewText.content = selected
    ? [
        selected.title,
        "",
        `Saved: ${formatConversationTimestamp(selected.updatedAt)}`,
        `Started: ${formatConversationTimestamp(selected.createdAt)}`,
        "",
        buildConversationPreview(selected.transcript),
      ].join("\n")
    : "No saved conversations.";
  renderer.requestRender();
}

async function refreshHistoryState() {
  historyItems = await loadConversationHistory();
  if (!historyItems.length) {
    historySelection = 0;
  } else if (historySelection >= historyItems.length) {
    historySelection = historyItems.length - 1;
  }

  if (historyMenuOpen) {
    await refreshHistoryPreview();
  }

  updateSidebar();
  updateComposerHint();
  renderer.requestRender();
}

function closeHistoryMenu() {
  if (!historyMenuOpen) {
    return;
  }

  historyMenuOpen = false;
  detachDetailPanel("history");
  updateSidebar();
  updateComposerHint();
  renderer.requestRender();
}

async function openHistoryMenu() {
  closeUpmergeMenu();
  closeModelMenu();
  historyMenuOpen = true;
  attachDetailPanel("history");
  await refreshHistoryState();
}

async function moveHistorySelection(delta: number) {
  if (!historyItems.length) {
    return;
  }

  historySelection = (historySelection + delta + historyItems.length) % historyItems.length;
  await refreshHistoryPreview();
  updateSidebar();
}

function filterModelItems(items: ModelMenuItem[], filter: string) {
  const query = filter.trim().toLowerCase();
  if (!query) {
    return items;
  }

  return items.filter((item) =>
    [item.id, item.label, item.description, item.provider]
      .join("\n")
      .toLowerCase()
      .includes(query)
  );
}

function selectedModelItem() {
  if (!filteredModelMenuItems.length) {
    return null;
  }

  return filteredModelMenuItems[Math.min(modelSelection, filteredModelMenuItems.length - 1)] ?? null;
}

function activeModelViewportTop() {
  return modelPreview.scrollTop;
}

function modelListHeight() {
  return Math.max(1, modelPreview.viewport.height);
}

function ensureModelSelectionVisible() {
  if (!filteredModelMenuItems.length) {
    modelPreview.scrollTo({ x: 0, y: 0 });
    return;
  }

  const headerLineCount = 4;
  const selectedTop = headerLineCount + modelSelection * 2;
  const selectedBottom = selectedTop + 1;
  const viewportTop = activeModelViewportTop();
  const viewportBottom = viewportTop + modelListHeight() - 1;

  if (selectedTop < viewportTop) {
    modelPreview.scrollTo({ x: 0, y: selectedTop });
  } else if (selectedBottom > viewportBottom) {
    modelPreview.scrollTo({
      x: 0,
      y: Math.max(0, selectedBottom - modelListHeight() + 1),
    });
  }
}

function updateModelMenuContent(note?: string) {
  const selected = selectedModelItem();
  const lines = [
    `Current model: ${currentModel}`,
    `Filter: ${modelFilter || "(none)"}`,
    `Matches: ${filteredModelMenuItems.length}/${modelMenuItems.length}`,
    "",
    filteredModelMenuItems.length
      ? filteredModelMenuItems
          .map((item, index) => {
            const prefix = index === modelSelection ? ">" : " ";
            const current = item.id === currentModel ? " ✓" : "";
            const meta = [item.provider, item.description].filter(Boolean).join(" • ");
            return `${prefix} ${item.id}${current}${meta ? `\n    ${meta}` : ""}`;
          })
          .join("\n")
      : "No models match the current filter.",
    "",
    "Shortcuts",
    "j / k  change selection",
    ".      filter/search",
    "Enter  select model",
    "Esc    close menu",
    "",
    modelMenuErrors.length
      ? `Warnings:\n${modelMenuErrors.map((error) => `- ${error}`).join("\n")}`
      : null,
    note ?? (selected ? `Selected: ${selected.id}` : "Select a model."),
  ].filter((line): line is string => line !== null);

  modelPreviewText.content = lines.join("\n");
  ensureModelSelectionVisible();
  renderer.requestRender();
}

function refreshFilteredModelItems() {
  filteredModelMenuItems = filterModelItems(modelMenuItems, modelFilter);
  if (!filteredModelMenuItems.length) {
    modelSelection = 0;
  } else if (modelSelection >= filteredModelMenuItems.length) {
    modelSelection = filteredModelMenuItems.length - 1;
  }
}

function closeModelMenu() {
  if (!modelMenuOpen) {
    return;
  }

  modelMenuOpen = false;
  detachDetailPanel("model");
  updateSidebar();
  updateComposerHint();
  renderer.requestRender();
}

async function openModelMenu() {
  closeUpmergeMenu();
  closeHistoryMenu();
  modelMenuOpen = true;
  modelFilter = "";
  modelSelection = 0;
  modelMenuItems = [];
  filteredModelMenuItems = [];
  modelMenuErrors = [];
  attachDetailPanel("model");
  updateSidebar("Loading available models...");
  updateModelMenuContent("Loading available models...");

  try {
    const result = await listAvailableModels();
    modelMenuItems = result.models.map((model) => ({
      id: model.id,
      label: model.label,
      description: model.description,
      provider: model.provider,
    }));
    modelMenuErrors = result.errors;
    refreshFilteredModelItems();
    updateSidebar("Model picker ready.");
    updateModelMenuContent();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    modelMenuErrors = [message];
    updateSidebar("Failed to load models.");
    updateModelMenuContent("Failed to load available models.");
  }
}

function moveModelSelection(delta: number) {
  if (!filteredModelMenuItems.length) {
    return;
  }

  modelSelection =
    (modelSelection + delta + filteredModelMenuItems.length) % filteredModelMenuItems.length;
  updateSidebar();
  updateModelMenuContent();
}

function backspaceModelFilter() {
  if (!modelFilter.length) {
    return;
  }

  modelFilter = modelFilter.slice(0, -1);
  refreshFilteredModelItems();
  updateSidebar();
  updateModelMenuContent();
}

function appendModelFilter(text: string) {
  if (!text) {
    return;
  }

  modelFilter += text;
  refreshFilteredModelItems();
  updateSidebar();
  updateModelMenuContent();
}

async function chooseSelectedModel() {
  const selected = selectedModelItem();
  if (!selected) {
    updateSidebar("No model selected.");
    updateModelMenuContent("No model selected.");
    return;
  }

  currentModel = selected.id;
  try {
    await savePersistedConfig({ currentModel });
    appendSystemMessage(
      `Switched model to \`${currentModel}\`. Future sessions will reuse it.`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendEntry(
      "error",
      `Switched model to \`${currentModel}\`, but failed to save it for future sessions.\n\n${message}`
    );
  }

  closeModelMenu();
  updateSidebar(`Using ${currentModel} for the next prompt.`);
  await persistActiveConversation();
}

async function loadSelectedHistoryConversation() {
  const selected = selectedHistoryItem();
  if (!selected) {
    updateSidebar("No saved conversations to load.");
    renderer.requestRender();
    return;
  }

  await archiveCurrentConversation();
  replaceConversationState(selected);
  insertDraft = "";
  commandDraft = "";
  shellDraft = "";
  agentShellDraft = "";
  input.setText("");
  await persistActiveConversation();
  closeHistoryMenu();
  updateSidebar(`Loaded conversation: ${selected.title}`);
  setMode("normal");
}

async function deleteSelectedHistoryConversation() {
  const selected = selectedHistoryItem();
  if (!selected) {
    updateSidebar("No saved conversations to delete.");
    renderer.requestRender();
    return;
  }

  try {
    await cleanupWorkspaceSession(selected.workspaceSession);
    await fs.unlink(selected.filePath);
    await refreshHistoryState();
    updateSidebar(`Deleted conversation: ${selected.title}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendEntry("error", `Failed to delete saved conversation.\n\n${message}`);
    updateSidebar("Failed to delete saved conversation.");
  }
  renderer.requestRender();
}

function setMode(nextMode: Mode) {
  if (nextMode !== "normal") {
    closeUpmergeMenu();
    closeHistoryMenu();
    closeModelMenu();
  }

  mode = nextMode;

  if (mode === "insert") {
    composer.title = "-- INSERT -- [history]";
    composer.borderColor = "#3b82f6";
    input.placeholder =
      "Type a message. Enter sends, Shift+Enter adds a new line, Up/Down browse history";
    setComposerText(insertDraft);
    process.nextTick(() => {
      if (mode === "insert") {
        input.focus();
        moveComposerCursorToEnd(insertDraft);
        renderer.requestRender();
      }
    });
  } else if (mode === "command") {
    composer.title = ": [history]";
    composer.borderColor = "#f59e0b";
    input.placeholder =
      "clear(c)  history(h)  model anthropic  index  quit(q)  (Up/Down history)";
    setComposerText(commandDraft);
    process.nextTick(() => {
      if (mode === "command") {
        input.focus();
        moveComposerCursorToEnd(commandDraft);
        renderer.requestRender();
      }
    });
  } else if (mode === "shell") {
    composer.title = "-- SHELL -- [history]";
    composer.borderColor = "#14b8a6";
    input.placeholder = "Type a shell command. Enter runs it locally. Up/Down browse history";
    setComposerText(shellDraft);
    process.nextTick(() => {
      if (mode === "shell") {
        input.focus();
        moveComposerCursorToEnd(shellDraft);
        renderer.requestRender();
      }
    });
  } else if (mode === "agent_shell") {
    composer.title = "-- AGENT SHELL -- [history]";
    composer.borderColor = "#8b5cf6";
    input.placeholder =
      "Type a shell command. Enter runs it and shares output with the agent. Up/Down history";
    setComposerText(agentShellDraft);
    process.nextTick(() => {
      if (mode === "agent_shell") {
        input.focus();
        moveComposerCursorToEnd(agentShellDraft);
        renderer.requestRender();
      }
    });
  } else {
    composer.title = "-- NORMAL --";
    composer.borderColor = "#334155";
    input.placeholder =
      "Press i to insert, : for commands, !/@ for shell, u for upmerge, or :history";
    setComposerText("");
    input.blur();
  }

  updateComposerHint();
  updateSidebar();
  renderer.requestRender();
}

function scrollToBottom(force = false) {
  if (!force && autoScrollState !== "follow") {
    return;
  }

  process.nextTick(() => {
    transcript.scrollTo({ x: 0, y: Number.MAX_SAFE_INTEGER });
    renderer.requestRender();
  });
}

function pauseAutoScroll() {
  autoScrollState = "paused";
}

function resumeAutoScroll() {
  autoScrollState = "follow";
  scrollToBottom(true);
}

async function settlePendingApproval(decision: ApprovalDecision) {
  const request = activeApproval;
  if (!request) {
    return;
  }

  activeApproval = null;

  await settleApprovalDecision({
    decision,
    request,
    approvedEditTargets,
    approvedShellCommands,
    savePersistedShellApprovals,
    appendSystemMessage: (content) => appendSystemMessage(content),
    appendErrorMessage: (content) => appendEntry("error", content),
    updateSidebar,
    afterQueueAdvanced: activateNextApproval,
    updateComposerHint,
    requestRender: () => renderer.requestRender(),
  });
}

function updateSidebar(note = "Ready for your next prompt.") {
  latestSidebarNote = note;
  const thinkingBadge =
    busy && activeThinkingIndicator
      ? ` ${THINKING_FRAMES[thinkingFrameIndex]} thinking`
      : "";

  if (activeApproval) {
    const approvalShortcuts =
      activeApproval.approvalPersistence === "persisted"
        ? [
            "y      approve once",
            "a      always approve this command",
            "n/Esc  deny this command",
          ]
        : ["y      approve for session", "n/Esc  deny this edit"];

    sidebar.title = "Approval";
    sidebar.borderColor = "#f59e0b";
    sidebarText.content = [
      "Status: waiting",
      `Tool: ${activeApproval.toolName}`,
      `${activeApproval.displayLabel}: ${activeApproval.displayValue}`,
      `Queued: ${queuedApprovals.length}`,
      "",
      "Shortcuts",
      ...approvalShortcuts,
      "",
      note,
    ].join("\n");
    return;
  }

  if (upmergeMenuOpen) {
    const items = currentUpmergeItems();
    sidebar.title = "Upmerge";
    sidebar.borderColor = "#22c55e";
    sidebarText.content = [
      `Edits: ${upmergeMode}`,
      `Pending: ${upmergeItems.length}`,
      "",
      items.length
        ? items
            .map(
              (item, index) =>
                `${index === upmergeSelection ? ">" : " "} ${item.label}`
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
    ].join("\n");
    return;
  }

  if (historyMenuOpen) {
    sidebar.title = "History";
    sidebar.borderColor = "#38bdf8";
    sidebarText.content = [
      `Saved chats: ${historyItems.length}`,
      "",
      historyItems.length
        ? historyItems
            .map(
              (item, index) =>
                `${index === historySelection ? ">" : " "} ${item.title} (${formatConversationTimestamp(
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
    ].join("\n");
    return;
  }

  sidebar.title = "Session";
  sidebar.borderColor = "#334155";
  sidebarText.content = [
    `Status: ${busy ? "streaming" : "idle"}${thinkingBadge}`,
    `Mode: ${mode}`,
    `Model: ${currentModel}`,
    `Messages: ${entries.length}`,
    `Upmerges: ${upmergeItems.length}`,
    "",
    "Shortcuts",
    "i      insert mode",
    ":      command mode",
    "!      shell mode",
    "@      agent shell mode",
    "j / k  scroll transcript",
    "G      jump to live bottom",
    "u      upmerge menu",
    "Esc    normal mode",
    "Ctrl+C abort stream/command",
    "",
    "Commands",
    ":clear reset conversation",
    ":history browse saved chats",
    ":index embed skill chunks",
    ":model open searchable model picker",
    ":quit  exit UI",
    "",
    upmergeNote,
    "",
    note,
  ].join("\n");
}

function updateComposerHint() {
  if (activeApproval) {
    composerHint.content =
      activeApproval.approvalPersistence === "persisted"
        ? `Approval required. Press y to allow this command once, a to always allow this exact command, or n to deny.${
            queuedApprovals.length
              ? ` ${queuedApprovals.length} more approval request(s) are queued.`
              : ""
          }`
        : `Approval required. Press y to allow this file for the session, or n to deny.${
            queuedApprovals.length
              ? ` ${queuedApprovals.length} more approval request(s) are queued.`
              : ""
          }`;
    return;
  }

  if (upmergeMenuOpen) {
    composerHint.content =
      "Upmerge menu open. Enter upmerges the selection, r reverts a selected file, and u/Esc closes it.";
    return;
  }

  if (historyMenuOpen) {
    composerHint.content =
      "History browser open. Enter loads the selected conversation, d deletes it, and Esc closes the browser.";
    return;
  }

  if (modelMenuOpen) {
    composerHint.content =
      "Model picker open. Use j/k to move, . to filter, Enter to select, Backspace to edit the filter, and Esc to close.";
    return;
  }

  if (busy) {
    composerHint.content =
      activeShellProcess
        ? autoScrollState === "paused"
          ? "A shell command is running. Auto-scroll is paused while you audit earlier output. Press G to jump back to the live bottom, or Ctrl+C to stop it."
          : "A shell command is running. Press Ctrl+C to stop it, or use j and k to inspect earlier messages."
        : autoScrollState === "paused"
          ? "The agent is responding. Auto-scroll is paused while you audit earlier output. Press G to jump back to the live bottom, or Ctrl+C to abort."
          : "The agent is responding. Press Ctrl+C to abort, or use j and k to inspect earlier messages.";
    return;
  }

  if (mode === "normal") {
    composerHint.content =
      "Normal mode. Press i to compose, : for commands, !/@ for shell, u for upmerge, or j/k to scroll.";
    return;
  }

  if (mode === "command") {
    composerHint.content =
      "Command mode. Run :clear, :history, :index, :model, or :quit, or press Esc to return to normal.";
    return;
  }

  if (mode === "shell") {
    composerHint.content =
      "Shell mode. Press Enter to run a local shell command that stays hidden from the agent.";
    return;
  }

  if (mode === "agent_shell") {
    composerHint.content =
      "Agent shell mode. Press Enter to run a shell command and add its command and output to the agent conversation.";
    return;
  }

  if (!insertDraft.trim()) {
    composerHint.content =
      "Insert mode. Press Enter to send or Shift+Enter to insert a new line.";
    return;
  }

  composerHint.content = `Ready to send ${
    insertDraft.trim().length
  } characters.`;
}

function appendEntry(
  role: ChatRole,
  content: string,
  options: {
    recordInTranscript?: boolean;
  } = {}
) {
  const theme = roleTheme(role);
  const container = new BoxRenderable(renderer, {
    id: nextId("message"),
    width: "100%",
    border: true,
    borderStyle: "rounded",
    borderColor: theme.border,
    backgroundColor: theme.background,
    title: theme.title,
    padding: 1,
  });

  const body = new TextRenderable(renderer, {
    id: nextId("message-body"),
    content: content || " ",
    fg: theme.foreground,
  });

  container.add(body);
  transcript.add(container);

  const entry: ChatEntry = {
    id: container.id,
    role,
    container,
    body,
  };

  entries.push(entry);
  if (options.recordInTranscript !== false) {
    transcriptHistory.push({ role, content });
  }
  updateSidebar();
  scrollToBottom();
  return entry;
}

function pushConversationMessage(
  message: Message,
  options: {
    localOnly?: boolean;
  } = {}
) {
  conversation.push(
    options.localOnly ? { ...message, localOnly: true } : message
  );
}

function appendSystemMessage(
  content: string,
  options: {
    localOnly?: boolean;
    recordInConversation?: boolean;
  } = {}
) {
  appendEntry("system", content);
  if (options.recordInConversation !== false) {
    pushConversationMessage(
      {
        role: "system",
        content,
      },
      { localOnly: options.localOnly ?? true }
    );
  }
  void persistActiveConversation();
}

function clearEntries() {
  for (const entry of [...entries]) {
    transcript.remove(entry.id);
  }
  entries.length = 0;
}

function restoreTranscriptFromHistory() {
  clearEntries();
  for (const entry of transcriptHistory) {
    appendEntry(entry.role, entry.content, { recordInTranscript: false });
  }
  updateSidebar();
  renderer.requestRender();
  scrollToBottom(true);
}

function replaceConversationState(state: PersistedConversationState) {
  activeConversationId = state.id;
  activeConversationCreatedAt = state.createdAt;
  configureConversationWorkspace(state.id);
  restoreWorkspaceSession(state.workspaceSession);
  conversation.splice(0, conversation.length, ...structuredClone(state.conversation));
  transcriptHistory.splice(0, transcriptHistory.length, ...structuredClone(state.transcript));
  clearApprovalQueue();
  approvedEditTargets.clear();
  autoScrollState = "follow";
  restoreTranscriptFromHistory();
}

async function resetConversation() {
  activeStreamAbortController?.abort();
  activeStreamAbortController = null;
  clearApprovalQueue();
  approvedEditTargets.clear();
  const archived = await archiveCurrentConversation();
  replaceConversationState(
    createInitialConversationState(createInitialConversationMessages())
  );
  insertDraft = "";
  commandDraft = "";
  shellDraft = "";
  agentShellDraft = "";
  input.setText("");
  await persistActiveConversation();
  updateComposerHint();
  updateSidebar(
    archived ? "Conversation cleared and saved to history." : "Conversation reset."
  );
  setMode("normal");
  renderer.requestRender();
}

async function shutdown() {
  await persistActiveConversation();
  renderer.destroy();
}

async function executeCommand(raw: string) {
  const command = raw.trim();

  if (!command) {
    commandDraft = "";
    setMode("normal");
    return;
  }

  if (command === "clear" || command === "c") {
    await resetConversation();
    return;
  }

  if (command === "model") {
    commandDraft = "";
    setMode("normal");
    await openModelMenu();
    return;
  }

  if (command.startsWith("model ")) {
    const requestedModel = resolveModelCommand(command.slice("model".length));

    if (!requestedModel) {
      appendEntry(
        "error",
        [
          `Unknown model target: \`${command.slice("model".length).trim()}\`.`,
          "",
          describeModelOptions(),
        ].join("\n")
      );
      commandDraft = "";
      setMode("normal");
      return;
    }

    currentModel = requestedModel;
    try {
      await savePersistedConfig({ currentModel });
      appendSystemMessage(
        `Switched model to \`${currentModel}\`. Future sessions will reuse it.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendEntry(
        "error",
        `Switched model to \`${currentModel}\`, but failed to save it for future sessions.\n\n${message}`
      );
    }
    updateSidebar(`Using ${currentModel} for the next prompt.`);
    commandDraft = "";
    setMode("normal");
    await persistActiveConversation();
    return;
  }

  if (command === "history" || command === "h") {
    commandDraft = "";
    setMode("normal");
    await openHistoryMenu();
    return;
  }

  if (command === "index") {
    commandDraft = "";
    setBusy(true);
    setMode("normal");
    updateSidebar("Indexing skill files with embeddings...");

    try {
      const index = await indexSkills(WORKSPACE_ROOT);
      appendSystemMessage(
        [
          `Indexed ${index.chunks.length} skill chunk${
            index.chunks.length === 1 ? "" : "s"
          }.`,
          `Skill files: ${
            new Set(index.chunks.map((chunk) => chunk.path)).size
          }.`,
          `Saved embeddings to \`.agents/skills-index.json\`.`,
          `Embedding model: \`${index.embeddingModel}\`.`,
        ].join("\n")
      );
      updateSidebar("Skill index refreshed.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendEntry("error", `Skill indexing failed.\n\n${message}`);
      updateSidebar("Skill indexing failed.");
    } finally {
      setBusy(false);
      updateComposerHint();
      renderer.requestRender();
    }
    return;
  }

  if (command === "quit" || command === "q") {
    await shutdown();
    return;
  }

  updateSidebar(`Unknown command: :${command}`);
  commandDraft = "";
  setMode("normal");
}

async function executeShellInput(raw: string, visibility: ShellVisibility) {
  const command = raw.trim();

  if (!command) {
    return;
  }

  const cwdLabel = ".";

  let stdout = "";
  let stderr = "";
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let shellResult: ShellExecutionResult = {
    stdout: "",
    stderr: "",
    exitCode: null,
    signal: null,
    startupError: null,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
  const transcriptIndex =
    transcriptHistory.push({
      role: "system",
      content: formatShellMessage({
        command,
        cwdLabel,
        stdout,
        stderr,
        exitCode: null,
        signal: null,
        startupError: null,
        stdoutTruncated,
        stderrTruncated,
        running: true,
        visibility,
      }),
    }) - 1;

  const entry = appendEntry(
    "system",
    formatShellMessage({
      command,
      cwdLabel,
      stdout,
      stderr,
      exitCode: null,
      signal: null,
      startupError: null,
      stdoutTruncated,
      stderrTruncated,
      running: true,
      visibility,
    }),
    { recordInTranscript: false }
  );

  const refreshEntry = (running: boolean) => {
    const content =
      formatShellMessage({
        command,
        cwdLabel,
        stdout,
        stderr,
        exitCode: shellResult.exitCode,
        signal: shellResult.signal,
        startupError: shellResult.startupError,
        stdoutTruncated,
        stderrTruncated,
        running,
        visibility,
      }) || " ";
    entry.body.content = content;
    transcriptHistory[transcriptIndex] = {
      role: "system",
      content,
    };
    renderer.requestRender();
    scrollToBottom();
  };

  setBusy(true);
  updateComposerHint();
  updateSidebar(`Running shell command in ${visibility} mode...`);
  renderer.requestRender();

  try {
    shellResult = await runShellCommandSession({
      command,
      onProcessStart: (child) => {
        activeShellProcess = child;
      },
      onProcessEnd: () => {
        activeShellProcess = null;
      },
      onUpdate: (state) => {
        stdout = state.stdout;
        stderr = state.stderr;
        stdoutTruncated = state.stdoutTruncated;
        stderrTruncated = state.stderrTruncated;
        shellResult = state.result;
        refreshEntry(state.running);
      },
    });

    stdout = shellResult.stdout;
    stderr = shellResult.stderr;
    stdoutTruncated = shellResult.stdoutTruncated;
    stderrTruncated = shellResult.stderrTruncated;
    refreshEntry(false);

    if (visibility === "agent") {
      pushConversationMessage({
        role: "system",
        content: formatShellMessage({
          command,
          cwdLabel,
          stdout,
          stderr,
          exitCode: shellResult.exitCode,
          signal: shellResult.signal,
          startupError: shellResult.startupError,
          stdoutTruncated,
          stderrTruncated,
          running: false,
          visibility,
        }),
      });
    }
    await persistActiveConversation();
  } finally {
    activeShellProcess = null;
    setBusy(false);
    updateComposerHint();
    updateSidebar(
      visibility === "agent"
        ? "Agent shell command complete."
        : "Shell command complete."
    );
    renderer.requestRender();
  }
}

async function submitPrompt() {
  if (busy) return;

  if (mode === "command") {
    await recordHistoryEntry("command", commandDraft);
    await executeCommand(commandDraft);
    return;
  }

  if (mode === "shell") {
    const command = shellDraft.trim();
    await recordHistoryEntry("shell", shellDraft);
    shellDraft = "";
    input.setText("");
    setMode("normal");
    await executeShellInput(command, "local");
    return;
  }

  if (mode === "agent_shell") {
    const command = agentShellDraft.trim();
    await recordHistoryEntry("agent_shell", agentShellDraft);
    agentShellDraft = "";
    input.setText("");
    setMode("normal");
    await executeShellInput(command, "agent");
    return;
  }

  if (mode !== "insert") {
    return;
  }

  const content = insertDraft.trim();
  if (!content) return;

  await recordHistoryEntry("insert", insertDraft);

  appendEntry("user", content);
  pushConversationMessage({
    role: "user",
    content,
  });
  await persistActiveConversation();

  setBusy(true);
  insertDraft = "";
  input.setText("");
  setMode("normal");
  startThinkingIndicator(`Connecting to ${currentModel}...`);
  updateSidebar(`Connecting to ${currentModel}...`);
  let streamAborted = false;

  try {
    let shouldContinueAgentLoop = true;

    while (shouldContinueAgentLoop && !streamAborted) {
      let sawAssistantOutput = false;
      let sawToolActivity = false;
      const streamAbortController = new AbortController();
      activeStreamAbortController = streamAbortController;

      let assistantEntry: ChatEntry | null = null;
      let assistantContent = "";
      let assistantTranscriptIndex: number | null = null;

      try {
        const result = streamResponse({
          model: currentModel,
          messages: conversation,
          tools,
          abortSignal: streamAbortController.signal,
        });

        for await (const chunk of result.stream) {
          switch (chunk.type) {
            case "reasoning":
              if (!activeThinkingIndicator) {
                startThinkingIndicator("Model is reasoning...");
              }
              updateSidebar("Model is reasoning...");
              break;
            case "content":
              stopThinkingIndicator();
              if (!assistantEntry) {
                assistantEntry = appendEntry("assistant", "", {
                  recordInTranscript: false,
                });
                assistantTranscriptIndex =
                  transcriptHistory.push({
                    role: "assistant",
                    content: "",
                  }) - 1;
              }
              assistantContent += chunk.content;
              assistantEntry.body.content = assistantContent || " ";
              if (assistantTranscriptIndex !== null) {
                transcriptHistory[assistantTranscriptIndex] = {
                  role: "assistant",
                  content: assistantContent,
                };
              }
              sawAssistantOutput = true;
              renderer.requestRender();
              scrollToBottom();
              break;
            case "tool-call-start":
              sawToolActivity = true;
              stopThinkingIndicator();
              updateSidebar(`Tool requested: ${chunk.toolName}`);
              break;
            case "tool-call-delta":
              sawToolActivity = true;
              stopThinkingIndicator();
              updateSidebar(`Preparing tool input: ${chunk.toolName}`);
              break;
            case "tool-result":
              sawToolActivity = true;
              stopThinkingIndicator();
              appendSystemMessage(
                summarizeToolResult(chunk.toolName, chunk.input, chunk.output) ??
                  [
                    `Tool \`${chunk.toolName}\` completed.`,
                    "",
                    formatToolOutput(chunk.output),
                  ].join("\n")
              );
              await refreshUpmergeState();
              updateSidebar(`Tool completed: ${chunk.toolName}`);
              break;
          }
        }

        const responseMessages = await result.responseMessages;
        conversation.push(...responseMessages);

        if (!assistantContent.trim() && !sawAssistantOutput) {
          const finalAssistantText = extractAssistantText(responseMessages);
          if (finalAssistantText.trim()) {
            appendEntry("assistant", finalAssistantText);
            sawAssistantOutput = true;
            assistantContent = finalAssistantText;
          }
        }
        await persistActiveConversation();

        if (
          !assistantContent.trim() &&
          !sawAssistantOutput &&
          !sawToolActivity &&
          !lastAssistantResponseContainsToolCall(responseMessages)
        ) {
          appendEntry(
            "assistant",
            "The model returned an empty response. Try another prompt."
          );
          shouldContinueAgentLoop = false;
        } else {
          shouldContinueAgentLoop =
            lastAssistantResponseContainsToolCall(responseMessages);
        }
      } catch (error) {
        if (
          streamAbortController.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          streamAborted = true;
          updateSidebar("Streaming aborted.");
        } else {
          throw error;
        }
      } finally {
        if (activeStreamAbortController === streamAbortController) {
          activeStreamAbortController = null;
        }
      }
    }

    if (!streamAborted) {
      updateSidebar("Streaming complete.");
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      streamAborted = true;
      updateSidebar("Streaming aborted.");
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    appendEntry("error", `Request failed.\n\n${message}`);
    updateSidebar(
      "Request failed. Check your model selection and AI provider credentials."
    );
    await persistActiveConversation();
  } finally {
    setBusy(false);
    updateComposerHint();
    updateSidebar(
      streamAborted
        ? "Stream aborted. Ready for your next prompt."
        : "Ready for your next prompt."
    );
    renderer.requestRender();
    scrollToBottom();
  }
}

function isColonKey(key: KeyEvent) {
  return key.sequence === ":" || (key.shift && key.name === ";");
}

function isShellKey(key: KeyEvent) {
  return key.sequence === "!" || (key.shift && key.name === "1");
}

function isAgentShellKey(key: KeyEvent) {
  return key.sequence === "@" || (key.shift && key.name === "2");
}

function handleGlobalKey(key: KeyEvent) {
  if (key.ctrl && key.name === "c") {
    if (activeStreamAbortController) {
      updateSidebar("Aborting current stream...");
      activeStreamAbortController.abort();
      renderer.requestRender();
    } else if (activeShellProcess) {
      updateSidebar("Stopping current shell command...");
      activeShellProcess.kill("SIGINT");
      renderer.requestRender();
    } else {
      updateSidebar("No active stream or shell command to abort. Use :quit to exit.");
      renderer.requestRender();
    }
    return;
  }

  if (activeApproval) {
    if (key.name === "y") {
      void settlePendingApproval(
        activeApproval.approvalPersistence === "persisted" ? "once" : "session"
      );
    } else if (
      activeApproval.approvalPersistence === "persisted" &&
      key.name === "a"
    ) {
      void settlePendingApproval("always");
    } else if (key.name === "n" || key.name === "escape") {
      void settlePendingApproval("deny");
    }
    return;
  }

  if (upmergeMenuOpen) {
    if (key.name === "escape" || key.name === "u") {
      closeUpmergeMenu();
    } else if (key.name === "j" || key.name === "down") {
      void moveUpmergeSelection(1);
    } else if (key.name === "k" || key.name === "up") {
      void moveUpmergeSelection(-1);
    } else if (key.name === "enter" || key.name === "return") {
      void runUpmergeSelection("upmerge");
    } else if (key.name === "r") {
      void runUpmergeSelection("revert");
    }
    return;
  }

  if (historyMenuOpen) {
    if (key.name === "escape") {
      closeHistoryMenu();
    } else if (key.name === "j" || key.name === "down") {
      void moveHistorySelection(1);
    } else if (key.name === "k" || key.name === "up") {
      void moveHistorySelection(-1);
    } else if (key.name === "enter" || key.name === "return") {
      void loadSelectedHistoryConversation();
    } else if (key.name === "d" || key.name === "delete") {
      void deleteSelectedHistoryConversation();
    }
    return;
  }

  if (modelMenuOpen) {
    if (key.name === "escape") {
      closeModelMenu();
    } else if (key.name === "j" || key.name === "down") {
      moveModelSelection(1);
    } else if (key.name === "k" || key.name === "up") {
      moveModelSelection(-1);
    } else if (key.name === "enter" || key.name === "return") {
      void chooseSelectedModel();
    } else if (key.name === "backspace") {
      backspaceModelFilter();
    } else if (key.sequence === ".") {
      updateSidebar("Search active. Type to filter the model list.");
      updateModelMenuContent();
    } else if (
      key.sequence &&
      !key.ctrl &&
      !key.meta &&
      key.name !== "tab" &&
      key.name !== "escape"
    ) {
      appendModelFilter(key.sequence);
    }
    return;
  }

  if (key.name === "escape") {
    if (mode !== "normal") {
      setMode("normal");
    }
    return;
  }

  if (mode !== "normal") {
    const historyMode = modeToHistoryMode(mode);

    if (historyMode && (key.name === "up" || key.name === "down")) {
      if (navigateHistory(historyMode, key.name === "up" ? -1 : 1)) {
        return;
      }
    }

    return;
  }

  if (!busy && key.name === "i") {
    setMode("insert");
    return;
  }

  if (!busy && isColonKey(key)) {
    commandDraft = "";
    setMode("command");
    return;
  }

  if (!busy && isShellKey(key)) {
    shellDraft = "";
    setMode("shell");
    return;
  }

  if (!busy && isAgentShellKey(key)) {
    agentShellDraft = "";
    setMode("agent_shell");
    return;
  }

  if (key.name === "u") {
    void openUpmergeMenu();
    return;
  }

  if (key.name === "j") {
    pauseAutoScroll();
    transcript.scrollBy({ x: 0, y: 3 });
    updateSidebar(
      busy
        ? "Auto-scroll paused while streaming."
        : "Auto-scroll paused while you inspect the transcript."
    );
    updateComposerHint();
    renderer.requestRender();
    return;
  }

  if (key.name === "k") {
    pauseAutoScroll();
    transcript.scrollBy({ x: 0, y: -3 });
    updateSidebar(
      busy
        ? "Auto-scroll paused while streaming."
        : "Auto-scroll paused while you inspect the transcript."
    );
    updateComposerHint();
    renderer.requestRender();
    return;
  }

  if (key.name === "g" && key.shift) {
    resumeAutoScroll();
    updateSidebar(
      busy
        ? "Jumped back to the live bottom."
        : "Jumped to the bottom of the transcript."
    );
    updateComposerHint();
  }
}

renderer.keyInput.on("keypress", handleGlobalKey);

input.onContentChange = () => {
  const value = input.plainText;

  if (mode === "command") {
    commandDraft = value;
    syncHistoryDraft("command", value);
  } else if (mode === "shell") {
    shellDraft = value;
    syncHistoryDraft("shell", value);
  } else if (mode === "agent_shell") {
    agentShellDraft = value;
    syncHistoryDraft("agent_shell", value);
  } else {
    insertDraft = value;
    syncHistoryDraft("insert", value);
  }
  updateComposerHint();
};

input.onSubmit = () => {
  void submitPrompt();
};

restoreTranscriptFromHistory();
setMode("normal");
void refreshUpmergeState();
void persistActiveConversation();

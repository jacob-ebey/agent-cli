import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  createCliRenderer,
  type KeyEvent,
} from "@opentui/core";

import {
  generateTextResponse,
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
  buildModelMenuContent,
  computeModelViewportTop,
  filterModelItems,
  moveModelSelection as moveModelSelectionIndex,
  normalizeModelSelection,
  resolveModelCommand,
  selectedModelItem as getSelectedModelItem,
} from "./lib/agent/model-menu.ts";
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
import {
  loadInputHistory,
  navigateHistory,
  recordHistoryEntry,
  saveInputHistory,
  syncHistoryDraft,
} from "./lib/agent/input-history.ts";
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
import {
  appendTranscriptEntry,
  clearTranscriptEntries,
  restoreTranscriptEntries,
} from "./lib/agent/transcript-view.ts";
import {
  COMPOSER_MODE_CONFIG,
  ComposerTextarea,
  createAgentView,
} from "./lib/agent/view.ts";
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

function formatTranscriptEntryForSummary(entry: PersistedTranscriptEntry) {
  const label = entry.summary ? `${entry.role} summary` : entry.role;
  return `${label}:\n${entry.content}`;
}

function buildConversationSummaryPrompt() {
  const transcript = transcriptHistory
    .map((entry) => formatTranscriptEntryForSummary(entry))
    .join("\n\n");

  return [
    "Summarize this chat for future continuation after context compression.",
    "Keep only information that must survive in chat history. Assume anything on disk can be re-read later.",
    "Prioritize:",
    "- current user goal and constraints",
    "- decisions made and why",
    "- unresolved questions or next steps",
    "- important runtime findings not guaranteed to exist on disk",
    "- concise summaries of tool activity and outcomes",
    "- any temporary state the assistant should remember",
    "",
    "Omit or compress aggressively:",
    "- full file contents",
    "- verbose tool logs",
    "- details that can be rediscovered from the repository",
    "- repetitive back-and-forth",
    "",
    "Output plain text using this structure exactly:",
    "Summary:",
    "<short paragraph>",
    "",
    "Relevant context to retain:",
    "- ...",
    "",
    "Open questions / next steps:",
    "- ...",
    "",
    "Transcript:",
    transcript || "(empty)",
  ].join("\n");
}

async function summarizeActiveConversation() {
  if (busy) {
    updateSidebar("Wait for the current stream or shell command to finish before summarizing.");
    renderer.requestRender();
    return;
  }

  if (!hasMeaningfulTranscript()) {
    appendSystemMessage("Nothing to summarize yet.");
    commandDraft = "";
    setMode("normal");
    return;
  }

  commandDraft = "";
  setBusy(true);
  setMode("normal");
  startThinkingIndicator(`Summarizing conversation with ${currentModel}...`);
  updateSidebar(`Summarizing conversation with ${currentModel}...`);

  try {
    const summary = await generateTextResponse({
      model: currentModel,
      messages: [
        {
          role: "system",
          content:
            "You compress chat history for an agent. Preserve only non-recoverable context needed to continue the task well. Be concise and reliable.",
        },
        {
          role: "user",
          content: buildConversationSummaryPrompt(),
        },
      ],
    });

    if (!summary) {
      appendEntry(
        "error",
        "Conversation summarization returned an empty response. The existing chat history was left unchanged."
      );
      updateSidebar("Conversation summarization returned an empty response.");
      return;
    }

    const preservedConversation = createInitialConversationMessages();
    const preservedTranscript: PersistedTranscriptEntry[] = [
      {
        role: "system",
        content: "Previous conversation context was compressed into the following summary.",
        summary: true,
      },
      {
        role: "assistant",
        content: summary,
        summary: true,
      },
    ];

    conversation.splice(0, conversation.length, ...preservedConversation);
    transcriptHistory.splice(0, transcriptHistory.length, ...preservedTranscript);
    restoreTranscriptFromHistory();
    await persistActiveConversation();
    updateSidebar("Conversation summarized and compressed.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendEntry(
      "error",
      `Conversation summarization failed. Existing history was left unchanged.\n\n${message}`
    );
    updateSidebar("Conversation summarization failed.");
  } finally {
    setBusy(false);
    updateComposerHint();
    renderer.requestRender();
    scrollToBottom(true);
  }
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

type ShellMessageState = {
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
};

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
}: ShellMessageState) {
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

const {
  app,
  main,
  transcriptPanel,
  transcript,
  sidebar,
  sidebarText,
  upmergePanel,
  upmergePreview,
  upmergePreviewText,
  historyPanel,
  historyPreview,
  historyPreviewText,
  modelPanel,
  modelPreview,
  modelPreviewText,
  composer,
  input,
  composerHint,
} = createAgentView(renderer);

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

function isHistoryMode(currentMode: Mode): currentMode is HistoryMode {
  return currentMode !== "normal";
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

async function recordAndPersistHistoryEntry(currentMode: HistoryMode, rawValue: string) {
  const changed = recordHistoryEntry({
    currentMode,
    rawValue,
    inputHistory,
    historyCursor,
    historyDrafts,
  });

  if (changed) {
    await persistInputHistory();
  }
}

function navigateHistoryInComposer(currentMode: HistoryMode, delta: -1 | 1) {
  const nextValue = navigateHistory({
    currentMode,
    delta,
    inputHistory,
    historyCursor,
    historyDrafts,
    currentDraftForMode,
    setDraftForMode,
  });

  if (nextValue === null) {
    return false;
  }

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

function selectedModelItem() {
  return getSelectedModelItem({
    filteredItems: filteredModelMenuItems,
    modelSelection,
  });
}

function ensureModelSelectionVisible() {
  const nextTop = computeModelViewportTop({
    currentScrollTop: modelPreview.scrollTop,
    viewportHeight: modelPreview.viewport.height,
    modelSelection,
    filteredItems: filteredModelMenuItems,
  });

  modelPreview.scrollTo({ x: 0, y: nextTop });
}

function updateModelMenuContent(note?: string) {
  modelPreviewText.content = buildModelMenuContent({
    currentModel,
    modelFilter,
    filteredItems: filteredModelMenuItems,
    allItems: modelMenuItems,
    modelSelection,
    modelMenuErrors,
    note,
  }).join("\n");
  ensureModelSelectionVisible();
  renderer.requestRender();
}

function refreshFilteredModelItems() {
  filteredModelMenuItems = filterModelItems(modelMenuItems, modelFilter);
  modelSelection = normalizeModelSelection({
    filteredItems: filteredModelMenuItems,
    modelSelection,
  });
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

  modelSelection = moveModelSelectionIndex({
    filteredItems: filteredModelMenuItems,
    modelSelection,
    delta,
  });
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

function applyComposerModeConfig(nextMode: Mode) {
  const config = COMPOSER_MODE_CONFIG[nextMode];
  composer.title = config.title;
  composer.borderColor = config.borderColor;
  input.placeholder = config.placeholder;
}

function focusComposerWithDraft(nextMode: Exclude<Mode, "normal">, draft: string) {
  setComposerText(draft);
  process.nextTick(() => {
    if (mode === nextMode) {
      input.focus();
      moveComposerCursorToEnd(draft);
      renderer.requestRender();
    }
  });
}

function setMode(nextMode: Mode) {
  if (nextMode !== "normal") {
    closeUpmergeMenu();
    closeHistoryMenu();
    closeModelMenu();
  }

  mode = nextMode;
  input.mode = nextMode;
  applyComposerModeConfig(nextMode);

  if (mode === "normal") {
    setComposerText("");
    input.blur();
  } else if (mode === "insert") {
    focusComposerWithDraft(mode, insertDraft);
  } else if (mode === "command") {
    focusComposerWithDraft(mode, commandDraft);
  } else if (mode === "shell") {
    focusComposerWithDraft(mode, shellDraft);
  } else {
    focusComposerWithDraft(mode, agentShellDraft);
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
    ":summarize compress chat history",
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
      "Command mode. Run :clear, :history, :index, :model, :summarize, or :quit, or press Esc to return to normal.";
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
  return appendTranscriptEntry({
    renderer,
    transcript,
    entries,
    transcriptHistory,
    nextId,
    role,
    content,
    recordInTranscript: options.recordInTranscript,
    onEntryAdded: () => {
      updateSidebar();
      scrollToBottom();
    },
  });
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
  clearTranscriptEntries({
    transcript,
    entries,
  });
}

function restoreTranscriptFromHistory() {
  restoreTranscriptEntries({
    rendererRequestRender: () => renderer.requestRender(),
    transcript,
    entries,
    transcriptHistory,
    appendEntry: (role, content, recordInTranscript) => {
      appendEntry(role, content, { recordInTranscript });
    },
    onRestored: () => {
      updateSidebar();
      scrollToBottom(true);
    },
  });
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
    const requestedModel = resolveModelCommand({
      input: command.slice("model".length),
      presets: MODEL_PRESETS,
    });

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

  if (command === "summarize" || command === "summary") {
    await summarizeActiveConversation();
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

function createInitialShellExecutionResult(): ShellExecutionResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: null,
    signal: null,
    startupError: null,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function createShellMessageState(
  command: string,
  visibility: ShellVisibility,
  result: ShellExecutionResult,
  running: boolean,
  cwdLabel = "."
): ShellMessageState {
  return {
    command,
    cwdLabel,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    signal: result.signal,
    startupError: result.startupError,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    running,
    visibility,
  };
}

function createShellTranscriptEntry(command: string, visibility: ShellVisibility) {
  let shellResult = createInitialShellExecutionResult();
  const initialState = createShellMessageState(command, visibility, shellResult, true);
  const transcriptIndex =
    transcriptHistory.push({
      role: "system",
      content: formatShellMessage(initialState),
    }) - 1;

  const entry = appendEntry("system", formatShellMessage(initialState), {
    recordInTranscript: false,
  });

  return {
    update(result: ShellExecutionResult, running: boolean) {
      shellResult = result;
      const content = formatShellMessage(
        createShellMessageState(command, visibility, shellResult, running)
      );
      entry.body.content = content || " ";
      transcriptHistory[transcriptIndex] = {
        role: "system",
        content,
      };
      renderer.requestRender();
      scrollToBottom();
    },
    snapshot(running: boolean) {
      return formatShellMessage(
        createShellMessageState(command, visibility, shellResult, running)
      );
    },
  };
}

async function executeShellInput(raw: string, visibility: ShellVisibility) {
  const command = raw.trim();

  if (!command) {
    return;
  }

  let shellResult = createInitialShellExecutionResult();
  const shellEntry = createShellTranscriptEntry(command, visibility);

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
        shellResult = state.result;
        shellEntry.update(shellResult, state.running);
      },
    });

    shellEntry.update(shellResult, false);

    if (visibility === "agent") {
      pushConversationMessage({
        role: "system",
        content: shellEntry.snapshot(false),
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
    await recordAndPersistHistoryEntry("command", commandDraft);
    await executeCommand(commandDraft);
    return;
  }

  if (mode === "shell") {
    const command = shellDraft.trim();
    await recordAndPersistHistoryEntry("shell", shellDraft);
    shellDraft = "";
    input.setText("");
    setMode("normal");
    await executeShellInput(command, "local");
    return;
  }

  if (mode === "agent_shell") {
    const command = agentShellDraft.trim();
    await recordAndPersistHistoryEntry("agent_shell", agentShellDraft);
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

  await recordAndPersistHistoryEntry("insert", insertDraft);

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
      if (navigateHistoryInComposer(historyMode, key.name === "up" ? -1 : 1)) {
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

function syncComposerDraft(value: string) {
  const currentMode = isHistoryMode(mode) ? mode : "insert";
  setDraftForMode(currentMode, value);
  syncHistoryDraft({
    currentMode,
    value,
    inputHistory,
    historyCursor,
    historyDrafts,
  });
}

input.onContentChange = () => {
  syncComposerDraft(input.plainText);
  updateComposerHint();
};

input.onSubmit = () => {
  void submitPrompt();
};

restoreTranscriptFromHistory();
setMode("normal");
void refreshUpmergeState();
void persistActiveConversation();

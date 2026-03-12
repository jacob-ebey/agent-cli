import * as fs from "node:fs/promises";
import * as path from "node:path";

import { createCliRenderer, type KeyEvent } from "@opentui/core";

import {
  generateTextResponse,
  listAvailableModels,
  type Message,
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
  ActiveShellSession,
  ModelMenuItem,
  ModelPresetName,
  PendingApproval,
  PersistedConfig,
  StreamPhase,
  PersistedConversationState,
  PersistedShellApprovals,
  PersistedTranscriptEntry,
  ShellExecutionResult,
  ShellVisibility,
  SidebarPresentationState,
  UpmergeMenuItem,
} from "./lib/agent/types.ts";
import {
  appendChunkWithLimit,
  extractAssistantText,
  formatToolOutput,
  isRecord,
  lastAssistantResponseContainsToolCall,
  readStringArgument,
} from "./lib/agent/utils.ts";
import {
  checkManualShellConstraints,
  checkToolConstraints,
  createSessionConstraintState,
  formatConstraintsSidebarSummary,
  recordSuccessfulEdit,
  recordSuccessfulShellCommand,
} from "./lib/agent/constraints.ts";
import {
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
import { loadInputHistory } from "./lib/agent/input-history.ts";
import {
  clearApprovalQueueState,
  currentApprovalPrompt,
  ensureToolApproval,
  getApprovalTarget,
  settleApprovalDecision,
  shiftNextPendingApproval,
} from "./lib/agent/approvals.ts";
import { runShellCommandSession } from "./lib/agent/shell-runner.ts";
import {
  loadAgentsMdInitialToolMessages,
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
  applySyntaxStyleToDiffRenderable,
  inferLanguageFromPath,
  isDiffLikeContent,
  renderEntryBody,
} from "./lib/agent/highlight.ts";
import {
  createAssistantStreamState,
  ensureAssistantStreamEntry,
  appendAssistantStreamContent,
  handleResponseChunk,
  applyFinalAssistantTextIfNeeded,
  shouldContinueAfterResponse,
  runSingleAgentTurn,
} from "./lib/agent/streaming.ts";
import {
  createInitialShellExecutionResult,
  createShellTranscriptEntry,
  formatShellMessage,
} from "./lib/agent/shell-session.ts";
import {
  COMPOSER_MODE_CONFIG,
  ComposerTextarea,
  attachDetailPanel as attachDetailPanelView,
  createAgentView,
  detachDetailPanel as detachDetailPanelView,
} from "./lib/agent/view.ts";
import {
  createComposerHintContent,
  createSidebarViewModel,
} from "./lib/agent/view-models.ts";
import {
  applyStreamStateEvent,
  type StreamStateMachineEvent,
} from "./lib/agent/stream-state.ts";
import { hasMeaningfulTranscript } from "./lib/agent/summarize.ts";
import {
  buildHistoryPreview,
  buildModelMenuView,
  currentUpmergeItems,
  loadModelMenuState,
  moveModelMenuSelection,
  refreshFilteredModelItems,
  refreshHistoryState as loadHistoryState,
  refreshUpmergePreview as loadUpmergePreview,
  refreshUpmergeState as loadUpmergeState,
  runUpmergeSelection as runUpmergeSelectionAction,
  selectedHistoryItem,
  selectedModelMenuItem,
} from "./lib/agent/menus.ts";
import {
  isAgentShellKey,
  isColonKey,
  isHistoryMode,
  isShellKey,
  modeToHistoryMode,
  moveComposerCursorToEnd,
  navigateHistoryInComposer,
  recordAndPersistHistoryEntry,
  syncComposerDraft,
} from "./lib/agent/input-controller.ts";
import {
  buildCritiquePrompt,
  buildReviewPrompt,
  copyWorktreePathCommand,
  describeHelpOptions,
  describeModelOptions,
  resolveRequestedModel,
  runAgentsMdCommand,
  runConstraintsCommand,
  runIndexCommand as runIndexCommandFlow,
  runMergeWorktreeCommand,
  showPlanCommand,
  summarizeConversationCommand,
} from "./lib/agent/commands.ts";
import {
  captureWorkspaceSession,
  cleanupWorkspaceSession,
  getActiveWorkspaceAbsolutePath,
  prepareWorkspaceForEdit,
  relativeOriginalWorkspacePath,
  revertRelativePath,
  restoreWorkspaceSession,
  resolveOriginalWorkspacePath,
  setConversationId,
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


const [initialSystemMessage, loadedTools] = await Promise.all([
  loadInitialSystemMessage(),
  loadTools(),
]);
const [initialToolMessages, agentsMdInitialToolMessages] = await Promise.all([
  loadInitialToolMessages(loadedTools),
  loadAgentsMdInitialToolMessages(loadedTools),
]);

const [persistedConfig, approvedShellCommands, persistedInputHistory] =
  await Promise.all([
    loadPersistedConfig(),
    loadPersistedShellApprovals(),
    loadInputHistory(),
  ]);
const sessionConstraintState = createSessionConstraintState();
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
      const approvalTarget = await getApprovalTarget(
        tool.definition.name,
        tool,
        parsedArguments
      );
      const constraintViolation = checkToolConstraints({
        toolName: tool.definition.name,
        targetPath: approvalTarget?.approvalPersistence === "session" ? approvalTarget.approvalKey : null,
        state: sessionConstraintState,
      });
      if (constraintViolation) {
        throw new Error(constraintViolation);
      }

      await ensureToolApproval(tool.definition.name, tool, parsedArguments, {
        approvedEditTargets,
        approvedShellCommands,
        enqueueApproval,
      });
      const output = await tool.execute(parsedArguments);
      if (tool.definition.name === "apply-patch" && approvalTarget?.approvalPersistence === "session") {
        recordSuccessfulEdit(approvalTarget.approvalKey, sessionConstraintState);
      }
      if (tool.definition.name === "run-shell-command") {
        const command = readStringArgument(parsedArguments, "command");
        if (command) {
          recordSuccessfulShellCommand(command, sessionConstraintState);
        }
      }
      return output;
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
setConversationId(activeConversationId);
restoreWorkspaceSession(initialConversationState.workspaceSession);
setConversationId(activeConversationId);

let nextIdCounter = 0;
let busy = false;
let streamPhase: StreamPhase = "idle";
let latestTotalTokensUsed: number | null = null;
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
let activeShellSession: ActiveShellSession | null = null;
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
  sendStreamStateEvent("await-approval");
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

  if (busy) {
    sendStreamStateEvent("approval-resolved");
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
  const spinner = busy
    ? ` ${THINKING_FRAMES[thinkingFrameIndex] ?? THINKING_FRAMES[0]}`
    : "";
  transcriptPanel.title = `Conversation${spinner}`;
}

function stopThinkingIndicator() {
  if (activeThinkingIndicator) {
    clearInterval(activeThinkingIndicator);
    activeThinkingIndicator = null;
  }
  thinkingFrameIndex = 0;
  updateTranscriptTitle();
}

function startThinkingIndicator(baseNote = latestSidebarNote) {
  latestSidebarNote = baseNote;
  if (activeThinkingIndicator) {
    return;
  }

  thinkingFrameIndex = 0;
  updateTranscriptTitle();
  updateSidebar(baseNote);
  renderer.requestRender();

  activeThinkingIndicator = setInterval(() => {
    thinkingFrameIndex = (thinkingFrameIndex + 1) % THINKING_FRAMES.length;
    updateTranscriptTitle();
    updateSidebar(baseNote);
    renderer.requestRender();
  }, 80);
}


async function summarizeActiveConversation() {
  await summarizeConversationCommand({
    busy,
    currentModel,
    transcriptHistory,
    setCommandDraft: (value) => {
      commandDraft = value;
    },
    setBusy,
    setModeNormal: () => setMode("normal"),
    startThinkingIndicator,
    sendStreamStateEvent,
    updateSidebar,
    appendSystemMessage,
    appendEntry: (role, content) => appendEntry(role, content),
    restoreTranscriptFromHistory,
    persistActiveConversation,
    updateComposerHint,
    requestRender: () => renderer.requestRender(),
    scrollToBottom,
    replaceWithSummarizedState: (state) => {
      conversation.splice(0, conversation.length, ...state.conversation);
      transcriptHistory.splice(0, transcriptHistory.length, ...state.transcript);
    },
    createInitialConversationMessages,
  });
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
  if (!hasMeaningfulTranscript(transcriptHistory) && captureWorkspaceSession() === null) {
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

function sendStreamStateEvent(event: StreamStateMachineEvent) {
  streamPhase = applyStreamStateEvent(streamPhase, event);
}

function setBusy(nextBusy: boolean) {
  busy = nextBusy;
  if (!busy) {
    stopThinkingIndicator();
    sendStreamStateEvent("reset");
  }
  updateTranscriptTitle();
}

function nextId(prefix: string) {
  nextIdCounter += 1;
  return `${prefix}-${nextIdCounter}`;
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
  upmergePreviewDiff,
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
void applySyntaxStyleToDiffRenderable(upmergePreviewDiff);

function setComposerText(value: string) {
  input.setText(value);
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


function selectedUpmergePreviewLanguage() {
  const selected = currentUpmergeItems(upmergeItems)[upmergeSelection] ?? null;
  return inferLanguageFromPath(selected?.path ?? null) ?? undefined;
}

function shouldRenderUpmergePreviewAsDiff(preview: string) {
  return (
    isDiffLikeContent(preview) &&
    !preview.startsWith("Text upmerge conflict: ") &&
    !preview.startsWith("Text worktree merge conflict: ") &&
    !preview.startsWith("Binary upmerge conflict: ") &&
    !preview.startsWith("Binary worktree merge conflict: ")
  );
}

function setUpmergePreviewContent(preview: string) {
  if (shouldRenderUpmergePreviewAsDiff(preview)) {
    try {
      upmergePreview.remove(upmergePreviewText.id);
    } catch {}
    if (!upmergePreview.getChildren().some((child) => child.id === upmergePreviewDiff.id)) {
      upmergePreview.add(upmergePreviewDiff);
    }
    upmergePreviewDiff.filetype = selectedUpmergePreviewLanguage();
    upmergePreviewDiff.diff = preview;
  } else {
    try {
      upmergePreview.remove(upmergePreviewDiff.id);
    } catch {}
    if (!upmergePreview.getChildren().some((child) => child.id === upmergePreviewText.id)) {
      upmergePreview.add(upmergePreviewText);
    }
    upmergePreviewText.content = preview;
  }
}

async function refreshUpmergePreview() {
  const preview = await loadUpmergePreview({
    upmergeMenuOpen,
    upmergeItems,
    upmergeSelection,
  });

  if (preview === null) {
    return;
  }

  setUpmergePreviewContent(preview);
  renderer.requestRender();
}

async function refreshUpmergeState() {
  const state = await loadUpmergeState({
    upmergeMenuOpen,
    upmergeSelection,
  });
  upmergeMode = state.upmergeMode;
  upmergeNote = state.upmergeNote;
  upmergeItems = state.upmergeItems;
  upmergeSelection = state.upmergeSelection;

  if (state.preview !== null) {
    setUpmergePreviewContent(state.preview);
  }

  updateSidebar();
  updateComposerHint();
  renderer.requestRender();
}

function attachDetailPanel(kind: Exclude<DetailPanel, null>) {
  detailPanelAttached = attachDetailPanelView({
    main,
    sidebar,
    upmergePanel,
    historyPanel,
    modelPanel,
    detailPanelAttached,
    kind,
  });
}

function detachDetailPanel(kind: Exclude<DetailPanel, null>) {
  detailPanelAttached = detachDetailPanelView({
    main,
    upmergePanel,
    historyPanel,
    modelPanel,
    detailPanelAttached,
    kind,
  });
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
  const items = currentUpmergeItems(upmergeItems);
  if (!items.length) {
    return;
  }

  upmergeSelection = (upmergeSelection + delta + items.length) % items.length;
  await refreshUpmergePreview();
  updateSidebar();
}

async function runUpmergeSelection(
  action:
    | "upmerge"
    | "revert"
    | "accept-main"
    | "accept-worktree"
    | "mark-resolved"
    | "auto-resolve"
) {
  const selectedItem = currentUpmergeItems(upmergeItems)[upmergeSelection] ?? null;

  try {
    if (action === "auto-resolve") {
      const selectedPath = selectedItem?.path;
      const conflictPhase = selectedItem?.conflictPhase;
      const statusMessage = selectedPath
        ? conflictPhase === "publish"
          ? `Auto-resolving publish conflict for ${selectedPath} with ${currentModel} using conversation history...`
          : `Auto-resolving worktree merge conflict for ${selectedPath} with ${currentModel}...`
        : `Auto-resolving selected conflict with ${currentModel}...`;
      updateSidebar(statusMessage);
      await appendSystemMessage(statusMessage);
      renderer.requestRender();
    }

    const result = await runUpmergeSelectionAction({
      upmergeItems,
      upmergeSelection,
      action,
      currentModel,
    });

    if (result.kind === "empty") {
      updateSidebar("No pending upmerges.");
      renderer.requestRender();
      return;
    }

    if (result.kind === "invalid-revert-all") {
      updateSidebar("Select a file to revert it.");
      renderer.requestRender();
      return;
    }

    if (action === "auto-resolve") {
      const selectedPath = selectedItem?.path;
      await appendSystemMessage(
        selectedPath
          ? `Auto-resolve finished for ${selectedPath}.\n\n${result.message}`
          : `Auto-resolve finished.\n\n${result.message}`
      );
    } else {
      await appendSystemMessage(result.message);
    }
    await refreshUpmergeState();
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (action === "auto-resolve") {
      const selectedPath = selectedItem?.path;
      await appendEntry(
        "error",
        selectedPath
          ? `Auto-resolve failed for ${selectedPath}.\n\n${message}`
          : `Auto-resolve failed.\n\n${message}`
      );
    } else {
      await appendEntry("error", message);
    }
  }

  await refreshUpmergeState();
}

async function refreshHistoryPreview() {
  historyPreviewText.content = buildHistoryPreview({
    historyItems,
    historySelection,
  });
  renderer.requestRender();
}

async function refreshHistoryState() {
  const state = await loadHistoryState({
    historyMenuOpen,
    historySelection,
  });
  historyItems = state.historyItems;
  historySelection = state.historySelection;

  if (state.preview !== null) {
    historyPreviewText.content = state.preview;
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


function updateModelMenuContent(note?: string) {
  const view = buildModelMenuView({
    currentModel,
    modelFilter,
    filteredModelMenuItems,
    modelMenuItems,
    modelSelection,
    modelMenuErrors,
    note,
    currentScrollTop: modelPreview.scrollTop,
    viewportHeight: modelPreview.viewport.height,
  });
  modelPreviewText.content = view.content;
  modelPreview.scrollTo({ x: 0, y: view.scrollTop });
  renderer.requestRender();
}

function refreshModelFilterState() {
  const state = refreshFilteredModelItems({
    modelMenuItems,
    modelFilter,
    modelSelection,
  });
  filteredModelMenuItems = state.filteredModelMenuItems;
  modelSelection = state.modelSelection;
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
    const result = await loadModelMenuState();
    modelMenuItems = result.modelMenuItems;
    modelMenuErrors = result.modelMenuErrors;
    refreshModelFilterState();
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
  modelSelection = moveModelMenuSelection({
    filteredModelMenuItems,
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
  refreshModelFilterState();
  updateSidebar();
  updateModelMenuContent();
}

function appendModelFilter(text: string) {
  if (!text) {
    return;
  }

  modelFilter += text;
  refreshModelFilterState();
  updateSidebar();
  updateModelMenuContent();
}

async function chooseSelectedModel() {
  const selected = selectedModelMenuItem({ filteredModelMenuItems, modelSelection });
  if (!selected) {
    updateSidebar("No model selected.");
    updateModelMenuContent("No model selected.");
    return;
  }

  currentModel = selected.id;
  await persistCurrentModelSelection();
  closeModelMenu();
  updateSidebar(`Using ${currentModel} for the next prompt.`);
  await persistActiveConversation();
}

async function loadSelectedHistoryConversation() {
  const selected = selectedHistoryItem({ historyItems, historySelection });
  if (!selected) {
    updateSidebar("No saved conversations to load.");
    renderer.requestRender();
    return;
  }

  await archiveCurrentConversation();
  await replaceConversationState(selected);
  await refreshHistoryState();
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
  const selected = selectedHistoryItem({ historyItems, historySelection });
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
    await appendEntry("error", `Failed to delete saved conversation.\n\n${message}`);
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
      moveComposerCursorToEnd({ input, value: draft });
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

function formatTokenWindowLabel() {
  const used = Math.max(0, Math.round(latestTotalTokensUsed ?? 0));
  return `${used}`;
}

function buildSidebarPresentationState(): SidebarPresentationState {
  return {
    activeApproval,
    queuedApprovalsCount: queuedApprovals.length,
    upmergeMenuOpen,
    upmergeMode,
    upmergeItems,
    upmergeSelection,
    upmergeNote,
    historyMenuOpen,
    historyItems,
    historySelection,
    modelMenuOpen,
    busy,
    streamPhase,
    activeThinking: activeThinkingIndicator !== null,
    thinkingFrame: THINKING_FRAMES[thinkingFrameIndex] ?? THINKING_FRAMES[0],
    mode,
    currentModel,
    entriesCount: entries.length,
    tokenUsageLabel: `${Math.max(0, Math.round(latestTotalTokensUsed ?? 0))}`,
    tokenWindowLabel: formatTokenWindowLabel(),
    upmergeCount: upmergeItems.filter((item) => item.kind === "pending").length,
    autoScrollState,
    activeShellSession: activeShellSession !== null,
    insertDraft,
    constraintsSummary: formatConstraintsSidebarSummary(sessionConstraintState.constraints),
  };
}

function updateSidebar(note = "Ready for your next prompt.") {
  latestSidebarNote = note;
  const sidebarViewModel = createSidebarViewModel(
    buildSidebarPresentationState(),
    note
  );
  sidebar.title = sidebarViewModel.title;
  sidebar.borderColor = sidebarViewModel.borderColor;
  sidebarText.content = sidebarViewModel.content;

  if (upmergeMenuOpen) {
    const selected = currentUpmergeItems(upmergeItems)[upmergeSelection] ?? null;
    upmergePanel.title = selected?.kind === "conflict" ? "Upmerge Conflict" : "Upmerge Preview";
    upmergePanel.borderColor = selected?.kind === "conflict" ? "#f59e0b" : "#22c55e";
  } else {
    upmergePanel.title = "Upmerge Preview";
    upmergePanel.borderColor = "#22c55e";
  }
}

function updateComposerHint() {
  composerHint.content = createComposerHintContent(buildSidebarPresentationState());
}

function appendEntry(
  role: ChatRole,
  content: string,
  options: {
    recordInTranscript?: boolean;
    insertBeforeEntryId?: string;
    explicitLanguage?: string | null;
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
    explicitLanguage: options.explicitLanguage,
    recordInTranscript: options.recordInTranscript,
    insertBeforeEntryId: options.insertBeforeEntryId,
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

async function appendSystemMessage(
  content: string,
  options: {
    localOnly?: boolean;
    recordInConversation?: boolean;
    explicitLanguage?: string | null;
  } = {}
) {
  const entry = await appendEntry("system", content, {
    explicitLanguage: options.explicitLanguage,
  });
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
  return entry.id;
}

function clearEntries() {
  clearTranscriptEntries({
    transcript,
    entries,
  });
}

async function restoreTranscriptFromHistory() {
  await restoreTranscriptEntries({
    rendererRequestRender: () => renderer.requestRender(),
    transcript,
    entries,
    transcriptHistory,
    appendEntry: (role, content, recordInTranscript) => {
      return appendEntry(role, content, { recordInTranscript });
    },
    onRestored: () => {
      updateSidebar();
      scrollToBottom(true);
    },
  });
}

async function replaceConversationState(state: PersistedConversationState) {
  activeConversationId = state.id;
  activeConversationCreatedAt = state.createdAt;
  latestTotalTokensUsed = null;
  configureConversationWorkspace(state.id);
  setConversationId(state.id);
  restoreWorkspaceSession(state.workspaceSession);
  setConversationId(state.id);
  conversation.splice(0, conversation.length, ...structuredClone(state.conversation));
  transcriptHistory.splice(0, transcriptHistory.length, ...structuredClone(state.transcript));
  clearApprovalQueue();
  approvedEditTargets.clear();
  autoScrollState = "follow";
  await restoreTranscriptFromHistory();
}

async function resetConversation() {
  activeStreamAbortController?.abort();
  activeStreamAbortController = null;
  clearApprovalQueue();
  approvedEditTargets.clear();
  const archived = await archiveCurrentConversation();
  await replaceConversationState(
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

function exitCommandMode() {
  commandDraft = "";
  setMode("normal");
}

async function persistCurrentModelSelection() {
  try {
    await savePersistedConfig({ currentModel });
    await appendSystemMessage(
      `Switched model to \`${currentModel}\`. Future sessions will reuse it.`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendEntry(
      "error",
      `Switched model to \`${currentModel}\`, but failed to save it for future sessions.\n\n${message}`
    );
  }
}

async function openModelPickerFromCommand() {
  exitCommandMode();
  await openModelMenu();
}

async function setModelFromCommand(argument: string) {
  const requestedModel = resolveRequestedModel(argument);

  if (!requestedModel) {
    appendEntry(
      "error",
      [`Unknown model target: \`${argument.trim()}\`.`, "", describeModelOptions(currentModel)].join(
        "\n"
      )
    );
    exitCommandMode();
    return;
  }

  currentModel = requestedModel;
  await persistCurrentModelSelection();
  updateSidebar(`Using ${currentModel} for the next prompt.`);
  exitCommandMode();
  await persistActiveConversation();
}

async function openHistoryFromCommand() {
  exitCommandMode();
  await openHistoryMenu();
}

async function runIndexCommand() {
  await runIndexCommandFlow({
    setCommandDraft: (value) => {
      commandDraft = value;
    },
    setBusy,
    setModeNormal: () => setMode("normal"),
    updateSidebar,
    appendSystemMessage,
    appendEntry: (role, content) => appendEntry(role, content),
    updateComposerHint,
    requestRender: () => renderer.requestRender(),
  });
}

async function runAgentsMdCommandFlow() {
  await runAgentsMdCommand({
    busy,
    currentModel,
    loadedTools,
    initialSystemMessage,
    initialToolMessages: agentsMdInitialToolMessages,
    setCommandDraft: (value) => {
      commandDraft = value;
    },
    setBusy,
    setModeNormal: () => setMode("normal"),
    startThinkingIndicator,
    stopThinkingIndicator,
    updateSidebar,
    appendSystemMessage,
    appendEntry: (role, content) => appendEntry(role, content),
    updateComposerHint,
    requestRender: () => renderer.requestRender(),
    scrollToBottom,
  });
}

async function runPlanCommand(argument: string) {
  const trimmedArgument = argument.trim();

  if (trimmedArgument && trimmedArgument !== "copy") {
    commandDraft = "";
    setMode("normal");
    appendEntry(
      "error",
      ["Invalid plan arguments.", "", "Usage:", "- :plan", "- :plan copy"].join("\n")
    );
    updateSidebar("Invalid plan arguments.");
    renderer.requestRender();
    scrollToBottom(true);
    return;
  }

  await showPlanCommand({
    planPath: path.join(getActiveWorkspaceAbsolutePath(), ".agents", "PLAN.md"),
    copyPath: trimmedArgument === "copy",
    setCommandDraft: (value) => {
      commandDraft = value;
    },
    setModeNormal: () => setMode("normal"),
    appendSystemMessage,
    appendEntry: (role, content) => appendEntry(role, content),
    updateSidebar,
  });
  renderer.requestRender();
  scrollToBottom(true);
}

async function submitSyntheticPrompt(content: string, sidebarNote: string) {
  if (busy) {
    updateSidebar("Wait for the current stream or shell command to finish first.");
    renderer.requestRender();
    return;
  }

  await appendEntry("user", content);
  pushConversationMessage({
    role: "user",
    content,
  });
  await persistActiveConversation();

  setBusy(true);
  sendStreamStateEvent("start-connection");
  insertDraft = "";
  input.setText("");
  setMode("normal");
  startThinkingIndicator(`Connecting to ${currentModel}...`);
  updateSidebar(sidebarNote);
  await runAgentLoop();
}

async function runCritiqueCommand(argument: string) {
  const trimmed = argument.trim();
  if (!trimmed) {
    commandDraft = "";
    setMode("normal");
    appendEntry(
      "error",
      ["Missing critique target.", "", "Usage:", "- :critique <design, plan, or request>"].join("\n")
    );
    updateSidebar("Missing critique target.");
    renderer.requestRender();
    scrollToBottom(true);
    return;
  }

  commandDraft = "";
  await submitSyntheticPrompt(buildCritiquePrompt(trimmed), "Running critique...");
}

async function runReviewCommand() {
  commandDraft = "";
  const pendingPaths = upmergeItems
    .filter((item) => item.path && item.kind !== "action")
    .map((item) => item.path as string);
  await submitSyntheticPrompt(
    buildReviewPrompt({
      constraints: sessionConstraintState.constraints,
      validationFresh: sessionConstraintState.validationFresh,
      editedFiles: [...sessionConstraintState.editedFiles].map((filePath) =>
        relativeOriginalWorkspacePath(filePath)
      ),
      upmergeMode,
      upmergeNote,
      pendingPaths,
    }),
    sessionConstraintState.constraints.requireValidation && !sessionConstraintState.validationFresh
      ? "Reviewing session state. Validation is currently stale."
      : "Reviewing session state..."
  );
}

async function runConstraintsCommandFlow(argument: string) {
  await runConstraintsCommand({
    argument,
    currentConstraints: sessionConstraintState.constraints,
    setConstraints: (next) => {
      sessionConstraintState.constraints = next;
    },
    setCommandDraft: (value) => {
      commandDraft = value;
    },
    setModeNormal: () => setMode("normal"),
    appendSystemMessage,
    appendEntry: (role, content) => appendEntry(role, content),
    updateSidebar,
  });
  renderer.requestRender();
  scrollToBottom(true);
}

async function runMergeCommand(argument: string) {
  await runMergeWorktreeCommand({
    argument,
    setCommandDraft: (value) => {
      commandDraft = value;
    },
    setModeNormal: () => setMode("normal"),
    appendSystemMessage,
    appendEntry: (role, content) => appendEntry(role, content),
    updateSidebar,
  });
  renderer.requestRender();
  scrollToBottom(true);
}

async function runWorktreeCommand() {
  await copyWorktreePathCommand({
    worktreePath: getActiveWorkspaceAbsolutePath(),
    setCommandDraft: (value) => {
      commandDraft = value;
    },
    setModeNormal: () => setMode("normal"),
    appendSystemMessage,
    appendEntry: (role, content) => appendEntry(role, content),
    updateSidebar,
  });
  renderer.requestRender();
  scrollToBottom(true);
}

function runHelpCommand() {
  commandDraft = "";
  setMode("normal");
  void appendSystemMessage(describeHelpOptions(currentModel));
  updateSidebar("Displayed available commands.");
  renderer.requestRender();
  scrollToBottom(true);
}

async function executeCommand(raw: string) {
  const command = raw.trim();

  if (!command) {
    exitCommandMode();
    return;
  }

  if (command === "help") {
    runHelpCommand();
    return;
  }

  if (command === "agents-md") {
    await runAgentsMdCommandFlow();
    return;
  }

  if (command === "clear" || command === "c") {
    await resetConversation();
    return;
  }

  if (command === "model") {
    await openModelPickerFromCommand();
    return;
  }

  if (command.startsWith("model ")) {
    await setModelFromCommand(command.slice("model".length));
    return;
  }

  if (command === "history" || command === "h") {
    await openHistoryFromCommand();
    return;
  }

  if (command === "index") {
    await runIndexCommand();
    return;
  }

  if (command === "plan") {
    await runPlanCommand("");
    return;
  }

  if (command.startsWith("plan ")) {
    await runPlanCommand(command.slice("plan".length));
    return;
  }

  if (command === "review") {
    await runReviewCommand();
    return;
  }

  if (command === "constraints") {
    await runConstraintsCommandFlow("");
    return;
  }

  if (command.startsWith("constraints ")) {
    await runConstraintsCommandFlow(command.slice("constraints".length));
    return;
  }

  if (command.startsWith("critique ")) {
    await runCritiqueCommand(command.slice("critique".length));
    return;
  }

  if (command === "merge") {
    await runMergeCommand("");
    return;
  }

  if (command.startsWith("merge ")) {
    await runMergeCommand(command.slice("merge".length));
    return;
  }

  if (command === "summarize" || command === "summary") {
    await summarizeActiveConversation();
    return;
  }

  if (command === "worktree") {
    await runWorktreeCommand();
    return;
  }

  if (command === "quit" || command === "q") {
    await shutdown();
    return;
  }

  updateSidebar(`Unknown command: :${command}`);
  exitCommandMode();
}

async function executeShellInput(raw: string, visibility: ShellVisibility) {
  const command = raw.trim();

  if (!command) {
    return;
  }

  const shellConstraintViolation = checkManualShellConstraints(sessionConstraintState);
  if (shellConstraintViolation) {
    await appendEntry("error", shellConstraintViolation);
    updateSidebar("Shell command blocked by session constraints.");
    renderer.requestRender();
    scrollToBottom(true);
    return;
  }

  let shellResult = createInitialShellExecutionResult();
  const shellEntry = createShellTranscriptEntry({
    command,
    visibility,
    transcriptHistory,
    appendEntry: (role, content, options) => {
      const entry = appendEntry(role, content, options);
      if (entry instanceof Promise) {
        throw new Error("appendEntry must return synchronously for shell transcript entries.");
      }
      return entry;
    },
    requestRender: () => renderer.requestRender(),
    scrollToBottom: () => scrollToBottom(),
  });

  setBusy(true);
  updateComposerHint();
  updateSidebar(`Running shell command in ${visibility} mode...`);
  renderer.requestRender();

  try {
    shellResult = await runShellCommandSession({
      command,
      cwd: getActiveWorkspaceAbsolutePath(),
      onProcessStart: (session) => {
        activeShellSession = session;
      },
      onProcessEnd: () => {
        activeShellSession = null;
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
    recordSuccessfulShellCommand(command, sessionConstraintState);
    await persistActiveConversation();
  } finally {
    activeShellSession = null;
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

async function runAgentLoop() {
  let streamAborted = false;

  try {
    let shouldContinueAgentLoop = true;

    sendStreamStateEvent("connection-established");

    while (shouldContinueAgentLoop && !streamAborted) {
      const turnResult = await runSingleAgentTurn({
        model: currentModel,
        conversation,
        tools,
        createAbortController: () => new AbortController(),
        onAbortControllerCreated: (controller) => {
          activeStreamAbortController = controller;
        },
        onAbortControllerCleared: (controller) => {
          if (activeStreamAbortController === controller) {
            activeStreamAbortController = null;
          }
        },
        createState: createAssistantStreamState,
        onChunk: (chunk, state) =>
          handleResponseChunk({
            chunk,
            state,
            startThinkingIndicator,
            activeThinking: activeThinkingIndicator !== null,
            stopThinkingIndicator,
            updateSidebar,
            sendStreamStateEvent,
            appendAssistantContent: async (contentChunk) =>
              await appendAssistantStreamContent({
                state,
                contentChunk,
                transcriptHistory,
                ensureEntry: () =>
                  ensureAssistantStreamEntry({
                    state,
                    appendEntry: (role, content, options) => {
                      const entry = appendEntry(role, content, options);
                      if (entry instanceof Promise) {
                        throw new Error(
                          "appendEntry must return synchronously for assistant streaming entries."
                        );
                      }
                      return entry;
                    },
                    transcriptHistory,
                  }),
                stopThinkingIndicator,
                requestRender: () => renderer.requestRender(),
                scrollToBottom: () => scrollToBottom(),
              }),
            appendSystemMessage,
            summarizeToolResult,
            refreshUpmergeState,
          }),
        onResponseMessages: async (responseMessages, state) => {
          latestTotalTokensUsed = state.totalTokensUsed;
          applyFinalAssistantTextIfNeeded({
            state,
            responseMessages,
            appendEntry: (role, content) => {
              appendEntry(role, content, {
                insertBeforeEntryId: state.insertAfterEntryId ?? undefined,
              });
            },
          });
          updateSidebar();
          await persistActiveConversation();
          return await shouldContinueAfterResponse(state, responseMessages, async (role, content) => {
            await appendEntry(role, content);
          });
        },
        onAborted: () => {
          updateSidebar("Streaming aborted.");
        },
      });
      shouldContinueAgentLoop = turnResult.shouldContinue;
      streamAborted = turnResult.aborted;
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
    await appendEntry("error", `Request failed.\n\n${message}`);
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

async function submitPrompt() {
  if (busy) return;

  if (mode === "command") {
    await recordAndPersistHistoryEntry({
      currentMode: "command",
      rawValue: commandDraft,
      inputHistory,
      historyCursor,
      historyDrafts,
      inputHistoryPath: INPUT_HISTORY_PATH,
    });
    await executeCommand(commandDraft);
    return;
  }

  if (mode === "shell") {
    const command = shellDraft.trim();
    await recordAndPersistHistoryEntry({
      currentMode: "shell",
      rawValue: shellDraft,
      inputHistory,
      historyCursor,
      historyDrafts,
      inputHistoryPath: INPUT_HISTORY_PATH,
    });
    shellDraft = "";
    input.setText("");
    setMode("normal");
    await executeShellInput(command, "local");
    return;
  }

  if (mode === "agent_shell") {
    const command = agentShellDraft.trim();
    await recordAndPersistHistoryEntry({
      currentMode: "agent_shell",
      rawValue: agentShellDraft,
      inputHistory,
      historyCursor,
      historyDrafts,
      inputHistoryPath: INPUT_HISTORY_PATH,
    });
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

  await recordAndPersistHistoryEntry({
    currentMode: "insert",
    rawValue: insertDraft,
    inputHistory,
    historyCursor,
    historyDrafts,
    inputHistoryPath: INPUT_HISTORY_PATH,
  });

  await appendEntry("user", content);
  pushConversationMessage({
    role: "user",
    content,
  });
  await persistActiveConversation();

  setBusy(true);
  sendStreamStateEvent("start-connection");
  insertDraft = "";
  input.setText("");
  setMode("normal");
  startThinkingIndicator(`Connecting to ${currentModel}...`);
  updateSidebar(`Connecting to ${currentModel}...`);
  await runAgentLoop();
}

function handleGlobalKey(key: KeyEvent) {
  if (key.ctrl && key.name === "c") {
    if (activeStreamAbortController) {
      updateSidebar("Aborting current stream...");
      activeStreamAbortController.abort();
      renderer.requestRender();
    } else if (activeShellSession) {
      updateSidebar("Stopping current shell command...");
      activeShellSession.abort();
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
    } else if (key.name === "m") {
      void runUpmergeSelection("mark-resolved");
    } else if (key.name === "a") {
      void runUpmergeSelection("auto-resolve");
    } else if (key.sequence === "1") {
      void runUpmergeSelection("accept-main");
    } else if (key.sequence === "2") {
      void runUpmergeSelection("accept-worktree");
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
      if (
        navigateHistoryInComposer({
          currentMode: historyMode,
          delta: key.name === "up" ? -1 : 1,
          inputHistory,
          historyCursor,
          historyDrafts,
          currentDraftForMode,
          setDraftForMode,
          setComposerText,
          moveComposerCursorToEnd: (value) => moveComposerCursorToEnd({ input, value }),
          updateComposerHint,
          requestRender: () => renderer.requestRender(),
        })
      ) {
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

function syncComposerDraftValue(value: string) {
  syncComposerDraft({
    mode,
    value,
    setDraftForMode,
    inputHistory,
    historyCursor,
    historyDrafts,
  });
}

input.onContentChange = () => {
  syncComposerDraftValue(input.plainText);
  updateComposerHint();
};

input.onSubmit = () => {
  void submitPrompt();
};

restoreTranscriptFromHistory();
setMode("normal");
void refreshUpmergeState();
void persistActiveConversation();
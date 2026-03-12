import type { ChildProcess } from "node:child_process";

import type { BoxRenderable, CodeRenderable, DiffRenderable, TextRenderable } from "@opentui/core";

import type { Message, Tool } from "../llm.ts";
import type { PersistedWorkspaceSession } from "../../worktree.ts";
import type { MODEL_PRESETS } from "./constants.ts";

export type ChatRole = "assistant" | "user" | "system" | "error";
export type Mode = "normal" | "insert" | "command" | "shell" | "agent_shell";
export type ConversationMessage = Message & {
  localOnly?: boolean;
};

export type ChatEntryRenderKind = "text" | "code" | "diff";

export type ChatEntry = {
  id: string;
  role: ChatRole;
  container: BoxRenderable;
  body: TextRenderable | CodeRenderable | DiffRenderable;
  renderKind: ChatEntryRenderKind;
};

export type ToolExecutor = (
  argumentsObject: Record<string, unknown>
) => Promise<string>;

export type ApprovalScope = "path" | "command";
export type ApprovalPersistence = "session" | "persisted";
export type ApprovalDecision = "deny" | "once" | "session" | "always";

export type ToolMetadata = {
  requiresApproval: boolean;
  approvalScope: ApprovalScope;
  approvalPersistence: ApprovalPersistence;
};

export type ToolDefinition = Pick<Tool, "name" | "description" | "inputSchema">;

export type LoadedTool = {
  definition: ToolDefinition;
  execute: ToolExecutor;
  metadata: ToolMetadata;
};

export type UpmergeMenuItem = {
  label: string;
  path: string | null;
  kind?: "action" | "pending" | "conflict";
  conflictType?: "text" | "binary";
  conflictPhase?: "publish" | "sync-down";
  action?: "upmerge-all";
};

export type ModelMenuItem = {
  id: string;
  label: string;
  description: string;
  provider: "llm-gateway" | "ollama";
};

export type PendingApproval = {
  toolName: string;
  approvalKey: string;
  displayLabel: string;
  displayValue: string;
  approvalPersistence: ApprovalPersistence;
  resolve: (decision: ApprovalDecision) => void;
};

export type ApprovalTarget = {
  approvalKey: string;
  displayLabel: string;
  displayValue: string;
  approvalPersistence: ApprovalPersistence;
};

export type AutoScrollState = "follow" | "paused";
export type ModelPresetName = keyof typeof MODEL_PRESETS;

export type ConstraintAccessPolicy = "allow" | "ask" | "deny";

export type SessionConstraints = {
  readOnly: boolean;
  shellPolicy: ConstraintAccessPolicy;
  networkPolicy: ConstraintAccessPolicy;
  maxFiles: number | null;
  requireValidation: boolean;
};

export type SessionConstraintState = {
  constraints: SessionConstraints;
  editedFiles: Set<string>;
  validationFresh: boolean;
};

export type PersistedConfig = {
  currentModel?: string;
};

export type PersistedShellApprovals = {
  version?: 1;
  approvedCommands?: string[];
  startupCommands?: string[];
};

export type InputHistoryState = {
  version: 1;
  insert: string[];
  command: string[];
  shell: string[];
  agent_shell: string[];
};

export type HistoryMode = Exclude<Mode, "normal">;

export type ShellVisibility = "local" | "agent";
export type DetailPanel = "upmerge" | "history" | "model" | null;

export type ShellExecutionResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startupError: string | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

export type ActiveShellSession = {
  process: ChildProcess;
  abort: () => void;
};

export type PersistedTranscriptEntry = {
  role: ChatRole;
  content: string;
  summary?: boolean;
};

export type PersistedConversationState = {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  workspaceSession: PersistedWorkspaceSession | null;
  conversation: ConversationMessage[];
  transcript: PersistedTranscriptEntry[];
};

export type ConversationHistoryItem = PersistedConversationState & {
  filePath: string;
};

export type InitialToolMessageSeed = {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
};

export type AgentsContextResult = {
  markdown: string;
};

export type ShellMessageState = {
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

export type AssistantStreamState = {
  entry: ChatEntry | null;
  textBody: TextRenderable | null;
  content: string;
  transcriptIndex: number | null;
  sawOutput: boolean;
  sawToolActivity: boolean;
  insertAfterEntryId: string | null;
  totalTokensUsed: number | null;
};

export type SidebarViewModel = {
  title: string;
  borderColor: string;
  content: string;
};

export type StreamPhase = "idle" | "connecting" | "reasoning" | "responding" | "waiting";

export type SidebarPresentationState = {
  activeApproval: PendingApproval | null;
  queuedApprovalsCount: number;
  upmergeMenuOpen: boolean;
  upmergeMode: "direct" | "worktree";
  upmergeItems: UpmergeMenuItem[];
  upmergeSelection: number;
  upmergeNote: string;
  historyMenuOpen: boolean;
  historyItems: ConversationHistoryItem[];
  historySelection: number;
  modelMenuOpen: boolean;
  busy: boolean;
  streamPhase: StreamPhase;
  activeThinking: boolean;
  thinkingFrame: string;
  mode: Mode;
  currentModel: string;
  entriesCount: number;
  tokenUsageLabel: string;
  tokenWindowLabel: string;
  upmergeCount: number;
  autoScrollState: AutoScrollState;
  activeShellSession: boolean;
  insertDraft: string;
  constraintsSummary: string | null;
};

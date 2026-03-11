import type { BoxRenderable, TextRenderable } from "@opentui/core";

import type { Message, Tool } from "../llm.ts";
import type { PersistedWorkspaceSession } from "../../worktree.ts";
import type { MODEL_PRESETS } from "./constants.ts";

export type ChatRole = "assistant" | "user" | "system" | "error";
export type Mode = "normal" | "insert" | "command" | "shell" | "agent_shell";
export type ConversationMessage = Message & {
  localOnly?: boolean;
};

export type ChatEntry = {
  id: string;
  role: ChatRole;
  container: BoxRenderable;
  body: TextRenderable;
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
};

export type ModelMenuItem = {
  id: string;
  label: string;
  description: string;
  provider: "shopify" | "ollama";
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

export type PersistedTranscriptEntry = {
  role: ChatRole;
  content: string;
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

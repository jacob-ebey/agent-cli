import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

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
  CONFIG_DIRECTORY,
  CONFIG_PATH,
  CONVERSATION_HISTORY_DIRECTORY,
  CONVERSATION_WORKTREES_DIRECTORY,
  GITIGNORE_PATH,
  INITIAL_TOOL_SEEDS,
  INPUT_HISTORY_LIMIT,
  INPUT_HISTORY_PATH,
  LAUNCH_ARGUMENTS,
  MODEL_PRESETS,
  PLAN_GITIGNORE_ENTRY,
  PLAN_PATH,
  PREVIOUS_CONVERSATION_PATH,
  ROOT_AGENTS_PATH,
  SHELL_APPROVALS_PATH,
  SHELL_OUTPUT_CHAR_LIMIT,
  SHOULD_RECALL_PREVIOUS_SESSION,
  SYSTEM_PROMPT_PATH,
  THINKING_FRAMES,
  TOOLS_DIRECTORY,
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
  assistantMessageContainsToolCall,
  buildConversationPreview,
  extractAssistantText,
  extractTextParts,
  formatConversationTimestamp,
  formatToolOutput,
  isRecord,
  lastAssistantResponseContainsToolCall,
  matchOutputLabel,
  normalizeWhitespace,
  readIntegerArgument,
  readStringArgument,
} from "./lib/agent/utils.ts";
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


function parsePersistedModel(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function loadPersistedConfig(): Promise<PersistedConfig> {
  try {
    const source = await fs.readFile(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(source) as {
      currentModel?: unknown;
    };
    const currentModel = parsePersistedModel(parsed.currentModel);
    return currentModel ? { currentModel } : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }

    console.warn(`Failed to load agent config from ${CONFIG_PATH}:`, error);
    return {};
  }
}

async function savePersistedConfig(config: PersistedConfig) {
  await fs.mkdir(CONFIG_DIRECTORY, { recursive: true });
  await fs.writeFile(
    CONFIG_PATH,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf-8"
  );
}

function createConversationId() {
  return `${Date.now()}-${randomUUID()}`;
}

function createInitialConversationMessages(): ConversationMessage[] {
  return [
    {
      role: "system",
      content: initialSystemMessage,
    },
    ...initialToolMessages,
  ];
}

function normalizeChatRole(value: unknown): ChatRole | null {
  return value === "assistant" ||
    value === "user" ||
    value === "system" ||
    value === "error"
    ? value
    : null;
}

function parsePersistedTranscript(value: unknown): PersistedTranscriptEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const role = normalizeChatRole(entry.role);
    const content =
      typeof entry.content === "string" ? entry.content.trimEnd() : null;
    if (!role || content === null) {
      return [];
    }

    return [{ role, content }];
  });
}

function parsePersistedConversationMessages(
  value: unknown
): ConversationMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.role !== "string" || !("content" in entry)) {
      return [];
    }

    const localOnly =
      entry.localOnly === undefined
        ? undefined
        : entry.localOnly === true
          ? true
          : false;

    return [
      {
        ...(entry as Message),
        localOnly,
      },
    ];
  });
}

function summarizeConversationTitleFromTranscript(
  transcriptEntries: PersistedTranscriptEntry[]
) {
  const source =
    transcriptEntries.find((entry) => entry.role === "user")?.content ??
    transcriptEntries.find((entry) => entry.role === "assistant")?.content ??
    transcriptEntries[0]?.content ??
    "New conversation";
  const firstLine = source
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    return "New conversation";
  }

  return firstLine.length <= 72 ? firstLine : `${firstLine.slice(0, 69)}...`;
}

function createInitialConversationState(): PersistedConversationState {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: createConversationId(),
    title: "New conversation",
    createdAt: now,
    updatedAt: now,
    workspaceSession: null,
    conversation: createInitialConversationMessages(),
    transcript: [],
  };
}

function parsePersistedConversationState(
  value: unknown
): PersistedConversationState | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = typeof value.id === "string" && value.id.trim() ? value.id : null;
  const title =
    typeof value.title === "string" && value.title.trim()
      ? value.title.trim()
      : null;
  const createdAt =
    typeof value.createdAt === "string" && value.createdAt.trim()
      ? value.createdAt
      : null;
  const updatedAt =
    typeof value.updatedAt === "string" && value.updatedAt.trim()
      ? value.updatedAt
      : null;
  const conversationMessages = parsePersistedConversationMessages(
    value.conversation
  );
  const transcriptEntries = parsePersistedTranscript(value.transcript);
  const workspaceSession =
    isRecord(value.workspaceSession) &&
    value.workspaceSession.mode === "worktree" &&
    Array.isArray(value.workspaceSession.trackedFiles) &&
    typeof value.workspaceSession.gitRoot === "string" &&
    typeof value.workspaceSession.sessionRoot === "string" &&
    typeof value.workspaceSession.worktreeRoot === "string" &&
    typeof value.workspaceSession.worktreeWorkspaceRoot === "string" &&
    typeof value.workspaceSession.baselinesRoot === "string"
      ? ({
          version: 1,
          mode: "worktree",
          note:
            typeof value.workspaceSession.note === "string"
              ? value.workspaceSession.note
              : "Agent edits are isolated in a git worktree until you upmerge them.",
          trackedFiles: value.workspaceSession.trackedFiles.flatMap((entry) => {
            if (!isRecord(entry) || typeof entry.relativePath !== "string") {
              return [];
            }

            return [
              {
                relativePath: entry.relativePath,
                baselinePath:
                  typeof entry.baselinePath === "string" ? entry.baselinePath : null,
                exists: entry.exists === true,
              },
            ];
          }),
          gitRoot: value.workspaceSession.gitRoot,
          sessionRoot: value.workspaceSession.sessionRoot,
          worktreeRoot: value.workspaceSession.worktreeRoot,
          worktreeWorkspaceRoot: value.workspaceSession.worktreeWorkspaceRoot,
          baselinesRoot: value.workspaceSession.baselinesRoot,
        } satisfies PersistedWorkspaceSession)
      : null;

  if (!id || !title || !createdAt || !updatedAt || !conversationMessages.length) {
    return null;
  }

  return {
    version: 1,
    id,
    title,
    createdAt,
    updatedAt,
    workspaceSession,
    conversation: conversationMessages,
    transcript: transcriptEntries,
  };
}

async function loadPersistedConversationState(
  filePath: string
): Promise<PersistedConversationState | null> {
  try {
    const source = await fs.readFile(filePath, "utf-8");
    return parsePersistedConversationState(JSON.parse(source));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    console.warn(`Failed to load conversation state from ${filePath}:`, error);
    return null;
  }
}

async function savePersistedConversationState(
  filePath: string,
  state: PersistedConversationState
) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

async function saveConversationStateToHistory(state: PersistedConversationState) {
  await savePersistedConversationState(
    path.join(CONVERSATION_HISTORY_DIRECTORY, `${state.id}.json`),
    state
  );
}

async function loadConversationHistory() {
  try {
    const files = await fs.readdir(CONVERSATION_HISTORY_DIRECTORY);
    const loaded = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => {
          const filePath = path.join(CONVERSATION_HISTORY_DIRECTORY, file);
          const state = await loadPersistedConversationState(filePath);
          if (!state) {
            return null;
          }

          return {
            ...state,
            filePath,
          } satisfies ConversationHistoryItem;
        })
    );

    return loaded
      .filter((entry): entry is ConversationHistoryItem => entry !== null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [] as ConversationHistoryItem[];
    }

    console.warn(
      `Failed to load conversation history from ${CONVERSATION_HISTORY_DIRECTORY}:`,
      error
    );
    return [] as ConversationHistoryItem[];
  }
}

async function resolveInitialConversationState() {
  const [activeState, previousState] = await Promise.all([
    loadPersistedConversationState(ACTIVE_CONVERSATION_PATH),
    loadPersistedConversationState(PREVIOUS_CONVERSATION_PATH),
  ]);

  if (SHOULD_RECALL_PREVIOUS_SESSION) {
    return activeState && isMeaningfulConversationState(activeState)
      ? activeState
      : previousState && isMeaningfulConversationState(previousState)
        ? previousState
        : activeState ?? previousState ?? createInitialConversationState();
  }

  if (activeState && isMeaningfulConversationState(activeState)) {
    await savePersistedConversationState(PREVIOUS_CONVERSATION_PATH, activeState);
    await saveConversationStateToHistory(activeState);
  }

  return createInitialConversationState();
}


function isMeaningfulConversationState(
  state: PersistedConversationState | null
): state is PersistedConversationState {
  if (!state) {
    return false;
  }

  return (
    state.workspaceSession !== null ||
    state.transcript.some(
      (entry) =>
        entry.role === "user" || entry.role === "assistant" || entry.role === "error"
    )
  );
}


function parsePersistedShellCommand(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function emptyInputHistoryState(): InputHistoryState {
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

async function loadInputHistory(): Promise<InputHistoryState> {
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

async function saveInputHistory(history: InputHistoryState) {
  await fs.writeFile(
    INPUT_HISTORY_PATH,
    `${JSON.stringify(history, null, 2)}\n`,
    "utf-8"
  );
}

async function loadPersistedShellConfig() {
  try {
    const source = await fs.readFile(SHELL_APPROVALS_PATH, "utf-8");
    const parsed = JSON.parse(source) as {
      approvedCommands?: unknown;
      startupCommands?: unknown;
    };
    const approvedCommands = Array.isArray(parsed.approvedCommands)
      ? parsed.approvedCommands
          .map((entry) => parsePersistedShellCommand(entry))
          .filter((entry): entry is string => entry !== null)
      : [];
    const startupCommands = Array.isArray(parsed.startupCommands)
      ? parsed.startupCommands
          .map((entry) => parsePersistedShellCommand(entry))
          .filter((entry): entry is string => entry !== null)
      : [];

    return {
      approvedCommands: new Set(approvedCommands),
      startupCommands,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        approvedCommands: new Set<string>(),
        startupCommands: [],
      };
    }

    console.warn(
      `Failed to load shell config from ${SHELL_APPROVALS_PATH}:`,
      error
    );
    return {
      approvedCommands: new Set<string>(),
      startupCommands: [],
    };
  }
}

async function loadPersistedShellApprovals() {
  const config = await loadPersistedShellConfig();
  return config.approvedCommands;
}

async function savePersistedShellApprovals(approvedCommands: Set<string>) {
  const existingConfig = await loadPersistedShellConfig();
  const sortedApprovedCommands = [...approvedCommands].sort((left, right) =>
    left.localeCompare(right)
  );
  const payload: PersistedShellApprovals = {
    version: 1,
    ...(sortedApprovedCommands.length > 0
      ? { approvedCommands: sortedApprovedCommands }
      : {}),
    ...(existingConfig.startupCommands.length > 0
      ? { startupCommands: existingConfig.startupCommands }
      : {}),
  };

  await fs.mkdir(path.dirname(SHELL_APPROVALS_PATH), { recursive: true });
  await fs.writeFile(
    SHELL_APPROVALS_PATH,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf-8"
  );
}

async function ensurePlanFileReady() {
  await fs.mkdir(path.dirname(PLAN_PATH), { recursive: true });

  try {
    await fs.access(PLAN_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    await fs.writeFile(PLAN_PATH, "", "utf-8");
  }

  let gitignoreSource = "";

  try {
    gitignoreSource = await fs.readFile(GITIGNORE_PATH, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const existingEntries = new Set(
    gitignoreSource
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );

  if (existingEntries.has(PLAN_GITIGNORE_ENTRY)) {
    return;
  }

  const nextSource = gitignoreSource.trimEnd()
    ? `${gitignoreSource.trimEnd()}\n${PLAN_GITIGNORE_ENTRY}\n`
    : `${PLAN_GITIGNORE_ENTRY}\n`;

  await fs.writeFile(GITIGNORE_PATH, nextSource, "utf-8");
}

async function loadRootAgentsGuidance() {
  try {
    const source = await fs.readFile(ROOT_AGENTS_PATH, "utf-8");
    const trimmedSource = source.trim();
    if (!trimmedSource) {
      return null;
    }

    return [
      "Additional repository guidance from the workspace root `AGENTS.md` file:",
      "",
      "<AGENTS.md>",
      trimmedSource,
      "</AGENTS.md>",
    ].join("\n");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function loadInitialSystemMessage() {
  const [baseSystemPrompt, rootAgentsGuidance] = await Promise.all([
    fs.readFile(SYSTEM_PROMPT_PATH, "utf-8"),
    loadRootAgentsGuidance(),
  ]);

  return [
    baseSystemPrompt,
    rootAgentsGuidance,
  ]
    .filter((part) => part && part.trim())
    .join("\n\n");
}

function parseToolDefinition(source: string): ToolDefinition | null {
  const nameMatch = source.match(/^#\s*`?([a-zA-Z0-9_-]+)`?\s*$/m);
  const descriptionMatch = source.match(
    /##\s*Description\s*\n+([\s\S]*?)(?=\n##\s|\s*$)/
  );
  const parametersMatch = source.match(
    /##\s*Parameters\s*\n+```json\s*\n([\s\S]*?)\n```/
  );

  if (!nameMatch || !descriptionMatch || !parametersMatch) {
    return null;
  }

  return {
    name: nameMatch[1],
    description: normalizeWhitespace(descriptionMatch[1]),
    inputSchema: JSON.parse(parametersMatch[1]),
  };
}

function parseToolMetadata(source: string): ToolMetadata {
  const metadataMatch = source.match(
    /##\s*Metadata\s*\n+```json\s*\n([\s\S]*?)\n```/
  );
  if (!metadataMatch) {
    return {
      requiresApproval: false,
      approvalScope: "path",
      approvalPersistence: "session",
    };
  }

  const parsed = JSON.parse(metadataMatch[1]) as {
    requiresApproval?: unknown;
    approvalScope?: unknown;
    approvalPersistence?: unknown;
  };

  return {
    requiresApproval: parsed.requiresApproval === true,
    approvalScope: parsed.approvalScope === "command" ? "command" : "path",
    approvalPersistence:
      parsed.approvalPersistence === "persisted" ? "persisted" : "session",
  };
}

async function loadTools() {
  const files = await fs.readdir(TOOLS_DIRECTORY);
  const loadedTools = await Promise.all(
    files
      .filter((file) => file.endsWith(".md") && file !== "system-prompt.md")
      .map(async (file) => {
        const source = await fs.readFile(
          path.join(TOOLS_DIRECTORY, file),
          "utf-8"
        );
        const parsedDefinition = parseToolDefinition(source);
        const metadata = parseToolMetadata(source);
        if (!parsedDefinition) {
          return null;
        }

        const expectedName = path.basename(file, ".md");
        if (parsedDefinition.name !== expectedName) {
          throw new Error(
            `Tool definition name "${parsedDefinition.name}" must match "${expectedName}.md".`
          );
        }

        const modulePath = path.join(
          WORKSPACE_ROOT,
          TOOLS_DIRECTORY,
          `${expectedName}.ts`
        );
        const toolModule = (await import(pathToFileURL(modulePath).href)) as {
          execute?: ToolExecutor;
        };

        if (typeof toolModule.execute !== "function") {
          throw new Error(
            `Tool module "${expectedName}.ts" must export an execute function.`
          );
        }

        return [
          parsedDefinition.name,
          {
            definition: parsedDefinition,
            execute: toolModule.execute,
            metadata,
          },
        ] as const;
      })
  );

  return new Map(
    loadedTools.filter(
      (entry): entry is readonly [string, LoadedTool] => entry !== null
    )
  );
}

function createInitialToolResultOutput(output: string) {
  return {
    type: "text" as const,
    value: output,
  };
}

async function loadInitialToolMessages(loadedTools: Map<string, LoadedTool>) {
  const seeds: InitialToolMessageSeed[] = INITIAL_TOOL_SEEDS;
  const seededResults = await Promise.all(
    seeds.map(async (seed) => {
      const tool = loadedTools.get(seed.toolName);
      if (!tool) {
        return null;
      }

      const output = await tool.execute(seed.input);
      return {
        ...seed,
        output,
      };
    })
  );
  const completedSeeds = seededResults.filter(
    (
      seed
    ): seed is InitialToolMessageSeed & {
      output: string;
    } => seed !== null
  );

  if (completedSeeds.length === 0) {
    return [];
  }

  return [
    {
      role: "assistant",
      content: completedSeeds.map((seed) => ({
        type: "tool-call" as const,
        toolCallId: seed.toolCallId,
        toolName: seed.toolName,
        input: seed.input,
      })),
    },
    {
      role: "tool",
      content: completedSeeds.map((seed) => ({
        type: "tool-result" as const,
        toolCallId: seed.toolCallId,
        toolName: seed.toolName,
        output: createInitialToolResultOutput(seed.output),
      })),
    },
  ] satisfies ConversationMessage[];
}


function summarizeToolResult(
  toolName: string,
  input: unknown,
  output: unknown
) {
  const argumentsObject = isRecord(input) ? input : {};

  switch (toolName) {
    case "read_file": {
      const requestedPath = readStringArgument(argumentsObject, "path");
      const offset = readIntegerArgument(argumentsObject, "offset");
      const limit = readIntegerArgument(argumentsObject, "limit");
      const range = offset
        ? limit
          ? `Requested lines: ${offset}-${offset + limit - 1}.`
          : `Requested from line ${offset}.`
        : null;

      return [
        requestedPath
          ? `Read file \`${requestedPath}\`.`
          : "Read a workspace file.",
        range,
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "ripgrep": {
      const pattern = readStringArgument(argumentsObject, "pattern");
      const requestedPath = readStringArgument(argumentsObject, "path") ?? ".";
      const glob = readStringArgument(argumentsObject, "glob");
      const matches = matchOutputLabel(output, "Matches");
      const truncated = matchOutputLabel(output, "Truncated");

      return [
        pattern
          ? `Searched files in \`${requestedPath}\` for \`${pattern}\`.`
          : `Searched files in \`${requestedPath}\`.`,
        glob ? `Glob: \`${glob}\`.` : null,
        matches ? `${matches} result(s).` : null,
        truncated ? truncated : null,
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "search_skills": {
      const query = readStringArgument(argumentsObject, "query");
      const indexedChunks = matchOutputLabel(output, "Indexed chunks");
      const resultsCount =
        typeof output === "string"
          ? Array.from(output.matchAll(/^\d+\.\s/gm)).length
          : null;

      return [
        query
          ? `Searched indexed skills for \`${query}\`.`
          : "Searched indexed skills.",
        resultsCount !== null ? `${resultsCount} result(s).` : null,
        indexedChunks ? `Indexed chunks available: ${indexedChunks}.` : null,
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "run_shell_command": {
      const command = readStringArgument(argumentsObject, "command");
      const requestedPath = readStringArgument(argumentsObject, "cwd") ?? ".";
      const exitCode = matchOutputLabel(output, "Exit code");
      const timedOut = matchOutputLabel(output, "Timed out");

      return [
        command
          ? `Ran shell command \`${command}\` from \`${requestedPath}\`.`
          : `Ran a shell command from \`${requestedPath}\`.`,
        exitCode ? `Exit code: ${exitCode}.` : null,
        timedOut ? `Timed out: ${timedOut}.` : null,
      ]
        .filter(Boolean)
        .join("\n");
    }
    default:
      return null;
  }
}


async function getApprovalTarget(
  toolName: string,
  tool: LoadedTool,
  argumentsObject: Record<string, unknown>
) {
  if (!tool.metadata.requiresApproval) {
    return null;
  }

  // File edits are already isolated once the session has moved into a worktree.
  if (toolName === "apply-patch") {
    const session = await prepareWorkspaceForEdit();
    if (session.mode === "worktree") {
      return null;
    }
  }

  if (tool.metadata.approvalScope === "command") {
    const command = readStringArgument(argumentsObject, "command");
    if (!command) {
      return null;
    }

    return {
      approvalKey: command,
      displayLabel: "Command",
      displayValue: command,
      approvalPersistence: tool.metadata.approvalPersistence,
    };
  }

  const requestedPath = readStringArgument(argumentsObject, "path");
  if (!requestedPath) {
    return null;
  }

  const originalPath = resolveOriginalWorkspacePath(requestedPath);
  return {
    approvalKey: originalPath,
    displayLabel: "File",
    displayValue: relativeOriginalWorkspacePath(originalPath),
    approvalPersistence: tool.metadata.approvalPersistence,
  };
}

async function ensureToolApproval(
  toolName: string,
  tool: LoadedTool,
  argumentsObject: Record<string, unknown>
) {
  const target = await getApprovalTarget(toolName, tool, argumentsObject);
  if (!target) {
    return;
  }

  if (
    target.approvalPersistence === "session" &&
    approvedEditTargets.has(target.approvalKey)
  ) {
    return;
  }

  if (
    target.approvalPersistence === "persisted" &&
    approvedShellCommands.has(target.approvalKey)
  ) {
    return;
  }

  const decision = await new Promise<ApprovalDecision>((resolve) => {
    enqueueApproval({
      toolName,
      approvalKey: target.approvalKey,
      displayLabel: target.displayLabel,
      displayValue: target.displayValue,
      approvalPersistence: target.approvalPersistence,
      resolve,
    });
  });

  if (decision === "deny") {
    throw new Error(
      `${target.displayLabel} not approved: ${target.displayValue}.`
    );
  }
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
const initialConversationState = await resolveInitialConversationState();
const tools = Array.from(loadedTools.values(), (tool) => ({
  name: tool.definition.name,
  description: tool.definition.description,
  inputSchema: tool.definition.inputSchema,
  execute: async (input: unknown) => {
    const parsedArguments = isRecord(input) ? input : {};

    try {
      await ensureToolApproval(tool.definition.name, tool, parsedArguments);
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

function currentApprovalPrompt(request: PendingApproval) {
  return request.approvalPersistence === "persisted"
    ? "Press `y` to approve this command once, `a` to always approve this exact command, or `n` to deny."
    : "Press `y` to approve edits to this file for the rest of the session, or `n` to deny.";
}

function isApprovalAlreadyGranted(request: PendingApproval) {
  return request.approvalPersistence === "persisted"
    ? approvedShellCommands.has(request.approvalKey)
    : approvedEditTargets.has(request.approvalKey);
}

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
  if (activeApproval) {
    return;
  }

  while (queuedApprovals.length) {
    const next = queuedApprovals.shift()!;
    if (isApprovalAlreadyGranted(next)) {
      next.resolve(next.approvalPersistence === "persisted" ? "always" : "session");
      continue;
    }

    activeApproval = next;
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
  if (activeApproval) {
    activeApproval.resolve("deny");
    activeApproval = null;
  }

  while (queuedApprovals.length) {
    queuedApprovals.shift()?.resolve("deny");
  }
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

  if (decision === "session") {
    approvedEditTargets.add(request.approvalKey);
    appendSystemMessage(
      `Approved edits to \`${request.displayValue}\` for the rest of this session.`
    );
    updateSidebar(`Approved edits to ${request.displayValue}.`);
  } else if (decision === "once") {
    appendSystemMessage(
      `Approved ${request.displayLabel.toLowerCase()} \`${
        request.displayValue
      }\` once.`
    );
    updateSidebar(`Approved ${request.displayLabel.toLowerCase()} once.`);
  } else if (decision === "always") {
    approvedShellCommands.add(request.approvalKey);
    try {
      await savePersistedShellApprovals(approvedShellCommands);
      appendSystemMessage(
        `Always approved command \`${request.displayValue}\`. Saved to \`.agents/shell.json\`.`
      );
      updateSidebar(`Saved approval for command ${request.displayValue}.`);
    } catch (error) {
      approvedShellCommands.delete(request.approvalKey);
      const message = error instanceof Error ? error.message : String(error);
      appendEntry(
        "error",
        `Failed to save shell approval for \`${request.displayValue}\`: ${message}`
      );
      updateSidebar(`Failed to save approval for ${request.displayValue}.`);
      activateNextApproval();
      updateComposerHint();
      renderer.requestRender();
      request.resolve("deny");
      return;
    }
  } else {
    appendSystemMessage(
      `Denied ${request.displayLabel.toLowerCase()} \`${
        request.displayValue
      }\`.`
    );
    updateSidebar(
      `Denied ${request.displayLabel.toLowerCase()} ${request.displayValue}.`
    );
  }
  activateNextApproval();
  updateComposerHint();
  renderer.requestRender();
  request.resolve(decision);
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
  replaceConversationState(createInitialConversationState());
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

  const shell =
    process.platform === "win32"
      ? process.env.ComSpec || "cmd.exe"
      : process.env.SHELL || "/bin/sh";
  const shellArgs =
    process.platform === "win32"
      ? ["/d", "/s", "/c", command]
      : ["-lc", command];
  const cwd = WORKSPACE_ROOT;
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
    shellResult = await new Promise<ShellExecutionResult>((resolve) => {
      let child: ChildProcess;

      try {
        child = spawn(shell, shellArgs, {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        });
      } catch (error) {
        resolve({
          stdout,
          stderr,
          exitCode: null,
          signal: null,
          startupError: error instanceof Error ? error.message : String(error),
          stdoutTruncated,
          stderrTruncated,
        });
        return;
      }

      activeShellProcess = child;

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        const next = appendChunkWithLimit(stdout, chunk);
        stdout = next.value;
        stdoutTruncated ||= next.truncated;
        refreshEntry(true);
      });

      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        const next = appendChunkWithLimit(stderr, chunk);
        stderr = next.value;
        stderrTruncated ||= next.truncated;
        refreshEntry(true);
      });

      child.on("error", (error) => {
        resolve({
          stdout,
          stderr,
          exitCode: null,
          signal: null,
          startupError: error instanceof Error ? error.message : String(error),
          stdoutTruncated,
          stderrTruncated,
        });
      });

      child.on("close", (exitCode, signal) => {
        resolve({
          stdout,
          stderr,
          exitCode,
          signal,
          startupError: null,
          stdoutTruncated,
          stderrTruncated,
        });
      });
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

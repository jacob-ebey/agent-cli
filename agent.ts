import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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
  streamResponse,
  type Message,
  type ResponseChunk,
  type Tool,
} from "./lib/llm.ts";
import { indexSkills } from "./lib/skills-index.ts";
import {
  cleanupWorkspaceSession,
  getUpmergePreview,
  getUpmergeStatus,
  prepareWorkspaceForEdit,
  relativeOriginalWorkspacePath,
  revertRelativePath,
  resolveOriginalWorkspacePath,
  upmergeAll,
  upmergeRelativePath,
} from "./worktree.ts";

const WORKSPACE_ROOT = process.cwd();
const TOOLS_DIRECTORY = "tools";
const SYSTEM_PROMPT_PATH = path.join(TOOLS_DIRECTORY, "system-prompt.md");
const ROOT_AGENTS_PATH = path.join(WORKSPACE_ROOT, "AGENTS.md");
const MODEL_PRESETS = {
  anthropic: "anthropic:claude-sonnet-4-6",
  openai: "openai:gpt-5.4",
  google: "google:gemini-3.1-pro-preview",
} as const;
const CONFIG_DIRECTORY =
  process.platform === "win32"
    ? path.join(
        process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"),
        "agent-cli"
      )
    : path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"),
        "agent-cli"
      );
const CONFIG_PATH = path.join(CONFIG_DIRECTORY, "config.json");
const SHELL_APPROVALS_PATH = path.join(WORKSPACE_ROOT, ".agents", "shell.json");
const INPUT_HISTORY_PATH = path.join(tmpdir(), "agent-cli-input-history.json");
const INPUT_HISTORY_LIMIT = 100;

type ChatRole = "assistant" | "user" | "system" | "error";
type Mode = "normal" | "insert" | "command" | "shell" | "agent_shell";
type ConversationMessage = Message & {
  localOnly?: boolean;
};

type ChatEntry = {
  id: string;
  role: ChatRole;
  container: BoxRenderable;
  body: TextRenderable;
};

type ToolExecutor = (
  argumentsObject: Record<string, unknown>
) => Promise<string>;

type ApprovalScope = "path" | "command";
type ApprovalPersistence = "session" | "persisted";
type ApprovalDecision = "deny" | "once" | "session" | "always";

type ToolMetadata = {
  requiresApproval: boolean;
  approvalScope: ApprovalScope;
  approvalPersistence: ApprovalPersistence;
};

type ToolDefinition = Pick<Tool, "name" | "description" | "inputSchema">;

type LoadedTool = {
  definition: ToolDefinition;
  execute: ToolExecutor;
  metadata: ToolMetadata;
};

type UpmergeMenuItem = {
  label: string;
  path: string | null;
};

type PendingApproval = {
  toolName: string;
  approvalKey: string;
  displayLabel: string;
  displayValue: string;
  approvalPersistence: ApprovalPersistence;
  resolve: (decision: ApprovalDecision) => void;
};

type AutoScrollState = "follow" | "paused";

type ModelPresetName = keyof typeof MODEL_PRESETS;
type PersistedConfig = {
  currentModel?: string;
};

type PersistedShellApprovals = {
  version: 1;
  approvedCommands: string[];
};

type InputHistoryState = {
  version: 1;
  insert: string[];
  command: string[];
  shell: string[];
  agent_shell: string[];
};

type HistoryMode = Exclude<Mode, "normal">;

type ShellVisibility = "local" | "agent";

type ShellExecutionResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startupError: string | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

const SHELL_OUTPUT_CHAR_LIMIT = 64_000;

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function appendChunkWithLimit(current: string, chunk: string) {
  if (current.length >= SHELL_OUTPUT_CHAR_LIMIT) {
    return {
      value: current,
      truncated: true,
    };
  }

  const remaining = SHELL_OUTPUT_CHAR_LIMIT - current.length;
  if (chunk.length <= remaining) {
    return {
      value: current + chunk,
      truncated: false,
    };
  }

  return {
    value: current + chunk.slice(0, remaining),
    truncated: true,
  };
}

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

async function loadPersistedShellApprovals() {
  try {
    const source = await fs.readFile(SHELL_APPROVALS_PATH, "utf-8");
    const parsed = JSON.parse(source) as {
      approvedCommands?: unknown;
    };
    const approvedCommands = Array.isArray(parsed.approvedCommands)
      ? parsed.approvedCommands
          .map((entry) => parsePersistedShellCommand(entry))
          .filter((entry): entry is string => entry !== null)
      : [];

    return new Set(approvedCommands);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Set<string>();
    }

    console.warn(
      `Failed to load shell approvals from ${SHELL_APPROVALS_PATH}:`,
      error
    );
    return new Set<string>();
  }
}

async function savePersistedShellApprovals(approvedCommands: Set<string>) {
  const payload: PersistedShellApprovals = {
    version: 1,
    approvedCommands: [...approvedCommands].sort((left, right) =>
      left.localeCompare(right)
    ),
  };

  await fs.mkdir(path.dirname(SHELL_APPROVALS_PATH), { recursive: true });
  await fs.writeFile(
    SHELL_APPROVALS_PATH,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf-8"
  );
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

  await fs.writeFile("DEBUG.txt", rootAgentsGuidance ?? "");

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatToolOutput(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function readStringArgument(
  argumentsObject: Record<string, unknown>,
  key: string
) {
  const value = argumentsObject[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readIntegerArgument(
  argumentsObject: Record<string, unknown>,
  key: string
) {
  const value = argumentsObject[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function matchOutputLabel(output: unknown, label: string) {
  if (typeof output !== "string") {
    return null;
  }

  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = output.match(new RegExp(`^${escapedLabel}:\\s+(.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
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
    case "search_files": {
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

function extractTextParts(content: unknown): string[] {
  if (typeof content === "string") {
    return content.trim() ? [content] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((part) => {
    if (typeof part !== "object" || part === null) {
      return [];
    }

    const candidate = part as {
      type?: unknown;
      text?: unknown;
    };

    if (
      candidate.type === "text" &&
      typeof candidate.text === "string" &&
      candidate.text.trim()
    ) {
      return [candidate.text];
    }

    return [];
  });
}

function extractAssistantText(messages: Message[]) {
  return messages
    .flatMap((message) => {
      if (message.role !== "assistant") {
        return [];
      }

      return extractTextParts((message as { content?: unknown }).content);
    })
    .join("");
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

const [initialSystemMessage, loadedTools] = await Promise.all([
  loadInitialSystemMessage(),
  loadTools(),
]);

const [persistedConfig, approvedShellCommands, persistedInputHistory] =
  await Promise.all([
    loadPersistedConfig(),
    loadPersistedShellApprovals(),
    loadInputHistory(),
  ]);
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
  {
    role: "system",
    content: initialSystemMessage,
  },
];

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
let upmergePanelAttached = false;
let activeStreamAbortController: AbortController | null = null;
let activeShellProcess: ChildProcess | null = null;
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

function setBusy(nextBusy: boolean) {
  busy = nextBusy;
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

function closeUpmergeMenu() {
  if (!upmergeMenuOpen) {
    return;
  }

  upmergeMenuOpen = false;
  if (upmergePanelAttached) {
    main.remove(upmergePanel.id);
    upmergePanelAttached = false;
  }
  updateSidebar();
  updateComposerHint();
  renderer.requestRender();
}

async function openUpmergeMenu() {
  upmergeMenuOpen = true;
  if (!upmergePanelAttached) {
    main.remove(sidebar.id);
    main.add(upmergePanel);
    main.add(sidebar);
    upmergePanelAttached = true;
  }
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

function setMode(nextMode: Mode) {
  if (nextMode !== "normal") {
    closeUpmergeMenu();
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
    input.placeholder = "clear  model anthropic  index  quit  (Up/Down history)";
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
      "Press i to insert, : for commands, !/@ for shell, or u for upmerge";
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

  sidebar.title = "Session";
  sidebar.borderColor = "#334155";
  sidebarText.content = [
    `Status: ${busy ? "streaming" : "idle"}`,
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
    ":index embed skill chunks",
    ":model switch providers",
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
      "Command mode. Run :clear, :index, :model, or :quit, or press Esc to return to normal.";
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

function appendEntry(role: ChatRole, content: string) {
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
}

function clearEntries() {
  for (const entry of [...entries]) {
    transcript.remove(entry.id);
  }
  entries.length = 0;
}

async function resetConversation() {
  activeStreamAbortController?.abort();
  activeStreamAbortController = null;
  clearApprovalQueue();
  approvedEditTargets.clear();
  clearEntries();
  conversation.splice(0, conversation.length, {
    role: "system",
    content: await loadInitialSystemMessage(),
  });
  insertDraft = "";
  commandDraft = "";
  shellDraft = "";
  agentShellDraft = "";
  input.setText("");
  autoScrollState = "follow";
  updateComposerHint();
  updateSidebar("Conversation reset.");
  setMode("normal");
  renderer.requestRender();
}

async function shutdown() {
  try {
    await cleanupWorkspaceSession();
  } finally {
    renderer.destroy();
  }
}

async function executeCommand(raw: string) {
  const command = raw.trim();

  if (!command) {
    commandDraft = "";
    setMode("normal");
    return;
  }

  if (command === "clear") {
    await resetConversation();
    return;
  }

  if (command === "model") {
    appendSystemMessage(describeModelOptions());
    commandDraft = "";
    setMode("normal");
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
    })
  );

  const refreshEntry = (running: boolean) => {
    entry.body.content =
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

  setBusy(true);
  insertDraft = "";
  input.setText("");
  setMode("normal");
  updateSidebar(`Connecting to ${currentModel}...`);
  let streamAborted = false;

  try {
    let sawAssistantOutput = false;
    let sawToolActivity = false;
    const streamAbortController = new AbortController();
    activeStreamAbortController = streamAbortController;

    let assistantEntry: ChatEntry | null = null;
    let assistantContent = "";

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
            updateSidebar("Model is reasoning...");
            break;
          case "content":
            if (!assistantEntry) {
              assistantEntry = appendEntry("assistant", "");
            }
            assistantContent += chunk.content;
            assistantEntry.body.content = assistantContent || " ";
            sawAssistantOutput = true;
            renderer.requestRender();
            scrollToBottom();
            break;
          case "tool-call-start":
            sawToolActivity = true;
            updateSidebar(`Tool requested: ${chunk.toolName}`);
            break;
          case "tool-call-delta":
            sawToolActivity = true;
            updateSidebar(`Preparing tool input: ${chunk.toolName}`);
            break;
          case "tool-result":
            sawToolActivity = true;
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

    if (
      !streamAborted &&
      !assistantContent.trim() &&
      !sawAssistantOutput &&
      !sawToolActivity
    ) {
      appendEntry(
        "assistant",
        "The model returned an empty response. Try another prompt."
      );
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

setMode("normal");
void refreshUpmergeState();

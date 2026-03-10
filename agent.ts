import * as fs from "node:fs/promises";
import { homedir } from "node:os";
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
  relativeOriginalWorkspacePath,
  revertRelativePath,
  resolveOriginalWorkspacePath,
  upmergeAll,
  upmergeRelativePath,
} from "./worktree.ts";

const WORKSPACE_ROOT = process.cwd();
const TOOLS_DIRECTORY = "tools";
const SYSTEM_PROMPT_PATH = path.join(TOOLS_DIRECTORY, "system-prompt.md");
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

type ChatRole = "assistant" | "user" | "system" | "error";
type Mode = "normal" | "insert" | "command";

type ChatEntry = {
  id: string;
  role: ChatRole;
  container: BoxRenderable;
  body: TextRenderable;
};

type ToolExecutor = (
  argumentsObject: Record<string, unknown>
) => Promise<string>;

type ToolMetadata = {
  requiresApproval: boolean;
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
  displayPath: string;
  resolve: (approved: boolean) => void;
};

type AutoScrollState = "follow" | "paused";

type ModelPresetName = keyof typeof MODEL_PRESETS;
type PersistedConfig = {
  currentModel?: string;
};

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
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
    };
  }

  const parsed = JSON.parse(metadataMatch[1]) as {
    requiresApproval?: unknown;
  };

  return {
    requiresApproval: parsed.requiresApproval === true,
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
          ? Array.from(output.matchAll(/^\d+\.\s/mg)).length
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

function getApprovalTarget(
  tool: LoadedTool,
  argumentsObject: Record<string, unknown>
) {
  if (!tool.metadata.requiresApproval) {
    return null;
  }

  const requestedPath = argumentsObject.path;
  if (typeof requestedPath !== "string" || !requestedPath.trim()) {
    return null;
  }

  const originalPath = resolveOriginalWorkspacePath(requestedPath);
  return {
    approvalKey: originalPath,
    displayPath: relativeOriginalWorkspacePath(originalPath),
  };
}

async function ensureToolApproval(
  toolName: string,
  tool: LoadedTool,
  argumentsObject: Record<string, unknown>
) {
  const target = getApprovalTarget(tool, argumentsObject);
  if (!target || approvedEditTargets.has(target.approvalKey)) {
    return;
  }

  const approved = await new Promise<boolean>((resolve) => {
    pendingApproval = {
      toolName,
      approvalKey: target.approvalKey,
      displayPath: target.displayPath,
      resolve,
    };
    appendEntry(
      "system",
      [
        `Approval required before \`${toolName}\` can edit \`${target.displayPath}\`.`,
        "",
        "Press `y` to approve edits to this file for the rest of the session, or `n` to deny.",
      ].join("\n")
    );
    updateSidebar(`Waiting for approval to edit ${target.displayPath}.`);
    updateComposerHint();
    renderer.requestRender();
  });

  if (!approved) {
    throw new Error(`Edit not approved for ${target.displayPath}.`);
  }
}

const [systemPrompt, loadedTools] = await Promise.all([
  fs.readFile(SYSTEM_PROMPT_PATH, "utf-8"),
  loadTools(),
]);
const persistedConfig = await loadPersistedConfig();
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

const conversation: Message[] = [
  {
    role: "system",
    content: `${systemPrompt}

You are running inside a prototype OpenTUI chat interface.
Use the available tools when they would help you inspect the workspace before answering.`,
  },
];

let nextIdCounter = 0;
let busy = false;
let mode: Mode = "normal";
let insertDraft = "";
let commandDraft = "";
const entries: ChatEntry[] = [];
let upmergeMode: "direct" | "worktree" = "direct";
let upmergeNote =
  "A git worktree will be created on the first edit when available.";
let upmergeItems: UpmergeMenuItem[] = [];
let upmergeMenuOpen = false;
let upmergeSelection = 0;
let upmergePanelAttached = false;
let activeStreamAbortController: AbortController | null = null;
const approvedEditTargets = new Set<string>();
let pendingApproval: PendingApproval | null = null;
let autoScrollState: AutoScrollState = "follow";
let currentModel: string =
  persistedConfig.currentModel ?? MODEL_PRESETS.anthropic;

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

function moveComposerCursorToEnd(value: string) {
  (input as TextareaRenderable & { cursorPosition: number }).cursorPosition =
    value.length;
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
    appendEntry("system", message);
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
    composer.title = "-- INSERT --";
    composer.borderColor = "#3b82f6";
    input.placeholder =
      "Type a message. Enter sends, Shift+Enter adds a new line";
    setComposerText(insertDraft);
    process.nextTick(() => {
      if (mode === "insert") {
        input.focus();
        moveComposerCursorToEnd(insertDraft);
        renderer.requestRender();
      }
    });
  } else if (mode === "command") {
    composer.title = ":";
    composer.borderColor = "#f59e0b";
    input.placeholder = "clear  model anthropic  index  quit";
    setComposerText(commandDraft);
    process.nextTick(() => {
      if (mode === "command") {
        input.focus();
        moveComposerCursorToEnd(commandDraft);
        renderer.requestRender();
      }
    });
  } else {
    composer.title = "-- NORMAL --";
    composer.borderColor = "#334155";
    input.placeholder = "Press i to insert, : for commands, or u for upmerge";
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

function settlePendingApproval(approved: boolean) {
  const request = pendingApproval;
  if (!request) {
    return;
  }

  pendingApproval = null;
  if (approved) {
    approvedEditTargets.add(request.approvalKey);
    appendEntry(
      "system",
      `Approved edits to \`${request.displayPath}\` for the rest of this session.`
    );
    updateSidebar(`Approved edits to ${request.displayPath}.`);
  } else {
    appendEntry("system", `Denied edits to \`${request.displayPath}\`.`);
    updateSidebar(`Denied edits to ${request.displayPath}.`);
  }
  updateComposerHint();
  renderer.requestRender();
  request.resolve(approved);
}

function updateSidebar(note = "Ready for your next prompt.") {
  if (pendingApproval) {
    sidebar.title = "Approval";
    sidebar.borderColor = "#f59e0b";
    sidebarText.content = [
      "Status: waiting",
      `Tool: ${pendingApproval.toolName}`,
      `File: ${pendingApproval.displayPath}`,
      "",
      "Shortcuts",
      "y      approve for session",
      "n/Esc  deny this edit",
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
    `Scroll: ${autoScrollState}`,
    `Messages: ${entries.length}`,
    `Model: ${currentModel}`,
    `Edits: ${upmergeMode}`,
    `Upmerges: ${upmergeItems.length}`,
    "",
    "Shortcuts",
    "i      insert mode",
    ":      command mode",
    "j / k  scroll transcript",
    "G      jump to live bottom",
    "u      upmerge menu",
    "Esc    normal mode",
    "Ctrl+C abort stream",
    "",
    "Commands",
    ":clear reset conversation",
    ":index embed skill chunks",
    ":model switch providers",
    ":quit  exit UI",
    "",
    "Gateway",
    "OPENAI_API_BASE",
    "OPENAI_API_KEY",
    "OPENAI_EMBEDDING_MODEL",
    "",
    upmergeNote,
    "",
    note,
  ].join("\n");
}

function updateComposerHint() {
  if (pendingApproval) {
    composerHint.content =
      "Approval required. Press y to allow this file for the session, or n to deny.";
    return;
  }

  if (upmergeMenuOpen) {
    composerHint.content =
      "Upmerge menu open. Enter upmerges the selection, r reverts a selected file, and u/Esc closes it.";
    return;
  }

  if (busy) {
    composerHint.content =
      autoScrollState === "paused"
        ? "The agent is responding. Auto-scroll is paused while you audit earlier output. Press G to jump back to the live bottom, or Ctrl+C to abort."
        : "The agent is responding. Press Ctrl+C to abort, or use j and k to inspect earlier messages.";
    return;
  }

  if (mode === "normal") {
    composerHint.content =
      "Normal mode. Press i to compose, : for commands, u for upmerge, or j/k to scroll.";
    return;
  }

  if (mode === "command") {
    composerHint.content =
      "Command mode. Run :clear, :index, :model, or :quit, or press Esc to return to normal.";
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

function clearEntries() {
  for (const entry of [...entries]) {
    transcript.remove(entry.id);
  }
  entries.length = 0;
}

function resetConversation() {
  clearEntries();
  conversation.splice(1);
  insertDraft = "";
  commandDraft = "";
  input.setText("");
  autoScrollState = "follow";
  updateSidebar("Conversation reset.");
  setMode("normal");
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
    resetConversation();
    return;
  }

  if (command === "model") {
    appendEntry("system", describeModelOptions());
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
      appendEntry(
        "system",
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
    busy = true;
    setMode("normal");
    updateSidebar("Indexing skill files with embeddings...");

    try {
      const index = await indexSkills(WORKSPACE_ROOT);
      appendEntry(
        "system",
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
      busy = false;
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

async function submitPrompt() {
  if (busy) return;

  if (mode === "command") {
    await executeCommand(commandDraft);
    return;
  }

  if (mode !== "insert") {
    return;
  }

  const content = insertDraft.trim();
  if (!content) return;

  appendEntry("user", content);
  conversation.push({
    role: "user",
    content,
  });

  busy = true;
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
            appendEntry(
              "system",
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
    busy = false;
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

function handleGlobalKey(key: KeyEvent) {
  if (key.ctrl && key.name === "c") {
    if (activeStreamAbortController) {
      updateSidebar("Aborting current stream...");
      activeStreamAbortController.abort();
      renderer.requestRender();
    } else {
      updateSidebar("No active stream to abort. Use :quit to exit.");
      renderer.requestRender();
    }
    return;
  }

  if (pendingApproval) {
    if (key.name === "y") {
      settlePendingApproval(true);
    } else if (key.name === "n" || key.name === "escape") {
      settlePendingApproval(false);
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
  } else {
    insertDraft = value;
  }
  updateComposerHint();
};

input.onSubmit = () => {
  void submitPrompt();
};

setMode("normal");
void refreshUpmergeState();

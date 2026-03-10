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
  streamResponse,
  type Message,
  type ResponseChunk,
  type Tool,
  type ToolCall,
} from "./lib/llm.ts";
import {
  cleanupWorkspaceSession,
  getUpmergeLinePreview,
  getUpmergePreview,
  getUpmergeStatus,
  relativeOriginalWorkspacePath,
  revertLineChange,
  revertRelativePath,
  resolveOriginalWorkspacePath,
  upmergeAll,
  upmergeLineChange,
  upmergeRelativePath,
} from "./worktree.ts";

const WORKSPACE_ROOT = process.cwd();
const TOOLS_DIRECTORY = "tools";
const BACKEND_URL = "http://localhost:8080/v1/chat/completions";
const SYSTEM_PROMPT_PATH = path.join(TOOLS_DIRECTORY, "system-prompt.md");

type ChatRole = "assistant" | "user" | "system" | "error";
type Mode = "normal" | "insert" | "command";

type ChatEntry = {
  id: string;
  role: ChatRole;
  container: BoxRenderable;
  body: TextRenderable;
};

type ToolExecutor = (argumentsObject: Record<string, unknown>) => Promise<string>;

type ToolMetadata = {
  requiresApproval: boolean;
};

type LoadedTool = {
  definition: Tool;
  execute: ToolExecutor;
  metadata: ToolMetadata;
};

type UpmergeScope = "files" | "lines";

type UpmergeMenuItem = {
  label: string;
  kind: "all" | "file" | "line";
  path: string | null;
  changeId?: string;
};

type PendingApproval = {
  toolName: string;
  approvalKey: string;
  displayPath: string;
  resolve: (approved: boolean) => void;
};

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function parseToolDefinition(source: string): Tool | null {
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
    type: "function",
    function: {
      name: nameMatch[1],
      description: normalizeWhitespace(descriptionMatch[1]),
      parameters: JSON.parse(parametersMatch[1]),
    },
  };
}

function parseToolMetadata(source: string): ToolMetadata {
  const metadataMatch = source.match(/##\s*Metadata\s*\n+```json\s*\n([\s\S]*?)\n```/);
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
        const source = await fs.readFile(path.join(TOOLS_DIRECTORY, file), "utf-8");
        const parsedDefinition = parseToolDefinition(source);
        const metadata = parseToolMetadata(source);
        if (!parsedDefinition) {
          return null;
        }

        const expectedName = path.basename(file, ".md");
        if (parsedDefinition.function.name !== expectedName) {
          throw new Error(
            `Tool definition name "${parsedDefinition.function.name}" must match "${expectedName}.md".`
          );
        }

        const modulePath = path.join(WORKSPACE_ROOT, TOOLS_DIRECTORY, `${expectedName}.ts`);
        const toolModule = (await import(pathToFileURL(modulePath).href)) as {
          execute?: ToolExecutor;
        };

        if (typeof toolModule.execute !== "function") {
          throw new Error(`Tool module "${expectedName}.ts" must export an execute function.`);
        }

        return [
          parsedDefinition.function.name,
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

async function executeToolCall(toolCall: ToolCall, loadedTools: Map<string, LoadedTool>) {
  let content: string;

  try {
    const parsedArguments = JSON.parse(toolCall.function.arguments || "{}") as Record<
      string,
      unknown
    >;

    const tool = loadedTools.get(toolCall.function.name);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolCall.function.name}`);
    }

    await ensureToolApproval(toolCall, tool, parsedArguments);
    content = await tool.execute(parsedArguments);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    content = `Tool execution failed: ${message}`;
  }

  return {
    role: "tool" as const,
    tool_call_id: toolCall.id,
    name: toolCall.function.name,
    arguments: toolCall.function.arguments,
    content,
  };
}

function collectToolCall(toolCalls: ToolCall[], chunk: NonNullable<ResponseChunk["toolCall"]>) {
  const existing = toolCalls[chunk.index];

  if ("id" in chunk) {
    toolCalls[chunk.index] = {
      index: chunk.index,
      id: chunk.id,
      type: "function",
      function: {
        name: chunk.function.name,
        arguments: `${existing?.function.arguments ?? ""}${chunk.function.arguments ?? ""}`,
      },
    };
    return;
  }

  toolCalls[chunk.index] = {
    index: chunk.index,
    id: existing?.id ?? `pending-tool-${chunk.index}`,
    type: "function",
    function: {
      name: existing?.function.name ?? "unknown",
      arguments: `${existing?.function.arguments ?? ""}${chunk.function.arguments}`,
    },
  };
}

function getApprovalTarget(tool: LoadedTool, argumentsObject: Record<string, unknown>) {
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
  toolCall: ToolCall,
  tool: LoadedTool,
  argumentsObject: Record<string, unknown>
) {
  const target = getApprovalTarget(tool, argumentsObject);
  if (!target || approvedEditTargets.has(target.approvalKey)) {
    return;
  }

  const approved = await new Promise<boolean>((resolve) => {
    pendingApproval = {
      toolName: toolCall.function.name,
      approvalKey: target.approvalKey,
      displayPath: target.displayPath,
      resolve,
    };
    appendEntry(
      "system",
      [
        `Approval required before \`${toolCall.function.name}\` can edit \`${target.displayPath}\`.`,
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
const tools = Array.from(loadedTools.values(), (tool) => tool.definition);

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
let upmergeNote = "A git worktree will be created on the first edit when available.";
let upmergeScope: UpmergeScope = "files";
let upmergeFileItems: UpmergeMenuItem[] = [];
let upmergeLineItems: UpmergeMenuItem[] = [];
let upmergeMenuOpen = false;
let upmergeSelection = 0;
let upmergePanelAttached = false;
let activeStreamAbortController: AbortController | null = null;
const approvedEditTargets = new Set<string>();
let pendingApproval: PendingApproval | null = null;

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
  if (upmergeScope === "lines") {
    return upmergeLineItems;
  }

  if (!upmergeFileItems.length) {
    return [];
  }

  return [
    { label: "Upmerge all pending files", kind: "all", path: null },
    ...upmergeFileItems,
  ];
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
  if (!selected) {
    upmergePreviewText.content =
      upmergeScope === "lines" ? "No pending line changes." : "No pending upmerges.";
  } else if (selected.kind === "line" && selected.path && selected.changeId) {
    upmergePreviewText.content = await getUpmergeLinePreview(selected.path, selected.changeId);
  } else {
    upmergePreviewText.content = await getUpmergePreview(selected.path ?? undefined);
  }
  renderer.requestRender();
}

async function refreshUpmergeState() {
  const status = await getUpmergeStatus();
  upmergeMode = status.mode;
  upmergeNote = status.note;
  upmergeFileItems = status.pendingFiles.map((entry) => ({
    label: entry,
    kind: "file",
    path: entry,
  }));
  upmergeLineItems = status.pendingLineChanges.map((entry) => ({
    label: `${entry.relativePath}: ${entry.summary}`,
    kind: "line",
    path: entry.relativePath,
    changeId: entry.id,
  }));

  if (upmergeScope === "lines" && !upmergeLineItems.length) {
    upmergeScope = "files";
  }

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

async function setUpmergeScope(scope: UpmergeScope) {
  if (scope === upmergeScope) {
    return;
  }

  upmergeScope = scope;
  upmergeSelection = 0;
  await refreshUpmergePreview();
  updateSidebar();
}

async function runUpmergeSelection() {
  const selected = selectedUpmergeItem();
  if (!selected) {
    updateSidebar(
      upmergeScope === "lines" ? "No pending line changes." : "No pending upmerges."
    );
    renderer.requestRender();
    return;
  }

  try {
    const message =
      selected.kind === "all"
        ? await upmergeAll()
        : selected.kind === "line" && selected.path && selected.changeId
          ? await upmergeLineChange(selected.path, selected.changeId)
          : selected.path
            ? await upmergeRelativePath(selected.path)
            : "No pending upmerges.";
    appendEntry("system", message);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendEntry("error", message);
  }

  await refreshUpmergeState();
}

async function revertUpmergeSelection() {
  const selected = selectedUpmergeItem();
  if (!selected || selected.kind === "all") {
    updateSidebar("Select a file or line to revert.");
    renderer.requestRender();
    return;
  }

  try {
    const message =
      selected.kind === "line" && selected.path && selected.changeId
        ? await revertLineChange(selected.path, selected.changeId)
        : selected.path
          ? await revertRelativePath(selected.path)
          : "Select a file or line to revert.";
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
    input.placeholder = "Type a message. Enter sends, Shift+Enter adds a new line";
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
    input.placeholder = "clear  quit";
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
    input.placeholder = "Press i to insert, : for commands, or u for pending edits";
    setComposerText("");
    input.blur();
  }

  updateComposerHint();
  updateSidebar();
  renderer.requestRender();
}

function scrollToBottom() {
  process.nextTick(() => {
    transcript.scrollTo({ x: 0, y: Number.MAX_SAFE_INTEGER });
    renderer.requestRender();
  });
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
      `Scope: ${upmergeScope}`,
      `Files: ${upmergeFileItems.length}`,
      `Lines: ${upmergeLineItems.length}`,
      "",
      items.length
        ? items
            .map((item, index) => `${index === upmergeSelection ? ">" : " "} ${item.label}`)
            .join("\n")
        : upmergeScope === "lines"
          ? "No pending line changes."
          : "No pending upmerges.",
      "",
      "Shortcuts",
      "Enter  upmerge selected item",
      "r      revert selected item",
      "f / l  switch file or line scope",
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
    `Messages: ${entries.length}`,
    `Edits: ${upmergeMode}`,
    `Pending files: ${upmergeFileItems.length}`,
    `Pending lines: ${upmergeLineItems.length}`,
    "",
    "Shortcuts",
    "i      insert mode",
    ":      command mode",
    "j / k  scroll transcript",
    "u      pending edits menu",
    "Esc    normal mode",
    "Ctrl+C abort stream",
    "",
    "Commands",
    ":clear reset conversation",
    ":quit  exit UI",
    "",
    "Backend",
    BACKEND_URL,
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
      "Pending edits menu open. Enter upmerges, r reverts, f/l switches scope, and u/Esc closes.";
    return;
  }

  if (busy) {
    composerHint.content =
      "The agent is responding. Press Ctrl+C to abort, or use j and k to inspect earlier messages.";
    return;
  }

  if (mode === "normal") {
    composerHint.content =
      "Normal mode. Press i to compose, : for commands, u for pending edits, or j/k to scroll.";
    return;
  }

  if (mode === "command") {
    composerHint.content =
      "Command mode. Run :clear or :quit, or press Esc to return to normal.";
    return;
  }

  if (!insertDraft.trim()) {
    composerHint.content =
      "Insert mode. Press Enter to send or Shift+Enter to insert a new line.";
    return;
  }

  composerHint.content = `Ready to send ${insertDraft.trim().length} characters.`;
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
  updateSidebar("Connecting to the local agent backend...");
  let streamAborted = false;

  try {
    let run = true;
    let sawAssistantOutput = false;

    while (run) {
      const streamAbortController = new AbortController();
      activeStreamAbortController = streamAbortController;

      let assistantEntry: ChatEntry | null = null;
      let assistantContent = "";
      const toolCalls: ToolCall[] = [];

      try {
        const stream = await streamResponse({
          messages: conversation,
          tools,
          abortSignal: streamAbortController.signal,
        });

        await stream.pipeTo(
          new WritableStream<ResponseChunk>({
            write(chunk) {
              if (chunk.reasoning) {
                updateSidebar("Model is reasoning...");
              }

              if (chunk.content) {
                if (!assistantEntry) {
                  assistantEntry = appendEntry("assistant", "");
                }
                assistantContent += chunk.content;
                assistantEntry.body.content = assistantContent || " ";
                sawAssistantOutput = true;
                renderer.requestRender();
                scrollToBottom();
              }

              if (chunk.toolCall) {
                collectToolCall(toolCalls, chunk.toolCall);
                const toolName =
                  "id" in chunk.toolCall
                    ? chunk.toolCall.function.name
                    : toolCalls[chunk.toolCall.index]?.function.name || "tool-call";
                updateSidebar(`Tool requested: ${toolName}`);
              }
            },
          }),
          {
            signal: streamAbortController.signal,
          }
        );
      } catch (error) {
        if (
          streamAbortController.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          streamAborted = true;
          updateSidebar("Streaming aborted.");
          break;
        }
        throw error;
      } finally {
        if (activeStreamAbortController === streamAbortController) {
          activeStreamAbortController = null;
        }
      }

      if (streamAborted) {
        break;
      }

      if (assistantContent.trim()) {
        conversation.push({
          role: "assistant",
          content: assistantContent,
        });
      }

      if (!toolCalls.length) {
        if (!assistantContent.trim() && !sawAssistantOutput) {
          appendEntry(
            "assistant",
            "The backend returned an empty response. Try another prompt."
          );
        }
        updateSidebar("Streaming complete.");
        run = false;
        continue;
      }

      for (const toolCall of toolCalls) {
        updateSidebar(`Running tool: ${toolCall.function.name}`);
        const toolResult = await executeToolCall(toolCall, loadedTools);
        conversation.push(toolResult);
        appendEntry(
          "system",
          [`Tool \`${toolCall.function.name}\` completed.`, "", toolResult.content].join("\n")
        );
        await refreshUpmergeState();
      }
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      streamAborted = true;
      updateSidebar("Streaming aborted.");
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    appendEntry("error", `Request failed.\n\n${message}`);
    updateSidebar("Request failed. Check that the local backend is running.");
  } finally {
    busy = false;
    updateComposerHint();
    updateSidebar(
      streamAborted ? "Stream aborted. Ready for your next prompt." : "Ready for your next prompt."
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
    } else if (key.name === "f") {
      void setUpmergeScope("files");
    } else if (key.name === "l") {
      void setUpmergeScope("lines");
    } else if (key.name === "j" || key.name === "down") {
      void moveUpmergeSelection(1);
    } else if (key.name === "k" || key.name === "up") {
      void moveUpmergeSelection(-1);
    } else if (key.name === "r") {
      void revertUpmergeSelection();
    } else if (key.name === "enter" || key.name === "return") {
      void runUpmergeSelection();
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
    transcript.scrollBy({ x: 0, y: 3 });
    renderer.requestRender();
    return;
  }

  if (key.name === "k") {
    transcript.scrollBy({ x: 0, y: -3 });
    renderer.requestRender();
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

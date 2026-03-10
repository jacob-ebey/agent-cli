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

type ParsedToolDefinition = {
  definition: Tool;
  metadata: ToolMetadata;
};

type PendingApproval = {
  toolName: string;
  resolve: (approved: boolean) => void;
};

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function parseToolDefinition(source: string): ParsedToolDefinition | null {
  const nameMatch = source.match(/^#\s*`?([a-zA-Z0-9_-]+)`?\s*$/m);
  const descriptionMatch = source.match(
    /##\s*Description\s*\n+([\s\S]*?)(?=\n##\s|\s*$)/
  );
  const parametersMatch = source.match(
    /##\s*Parameters\s*\n+```json\s*\n([\s\S]*?)\n```/
  );
  const metadataMatch = source.match(
    /##\s*Metadata\s*\n+```json\s*\n([\s\S]*?)\n```/
  );

  if (!nameMatch || !descriptionMatch || !parametersMatch) {
    return null;
  }

  return {
    definition: {
      type: "function",
      function: {
        name: nameMatch[1],
        description: normalizeWhitespace(descriptionMatch[1]),
        parameters: JSON.parse(parametersMatch[1]),
      },
    },
    metadata: {
      requiresApproval:
        metadataMatch !== null &&
        JSON.parse(metadataMatch[1]).requiresApproval === true,
    },
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
        if (!parsedDefinition) {
          return null;
        }

        const expectedName = path.basename(file, ".md");
        if (parsedDefinition.definition.function.name !== expectedName) {
          throw new Error(
            `Tool definition name "${parsedDefinition.definition.function.name}" must match "${expectedName}.md".`
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
          parsedDefinition.definition.function.name,
          {
            definition: parsedDefinition.definition,
            execute: toolModule.execute,
            metadata: parsedDefinition.metadata,
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

    if (tool.metadata.requiresApproval) {
      const approved = await requestToolApproval(toolCall.function.name, parsedArguments);
      if (!approved) {
        throw new Error(`User denied approval for ${toolCall.function.name}.`);
      }
    }

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
let pendingApproval: PendingApproval | null = null;

function formatApprovalArguments(argumentsObject: Record<string, unknown>) {
  const pretty = JSON.stringify(argumentsObject, null, 2) ?? "{}";
  const lines = pretty.split("\n");

  if (lines.length <= 80) {
    return pretty;
  }

  return [
    ...lines.slice(0, 80),
    `... (${lines.length - 80} more lines omitted)`,
  ].join("\n");
}

function settlePendingApproval(approved: boolean) {
  if (!pendingApproval) {
    return;
  }

  const { toolName, resolve } = pendingApproval;
  pendingApproval = null;
  appendEntry(
    "system",
    approved
      ? `Approved \`${toolName}\`.`
      : `Denied \`${toolName}\`.`
  );
  updateComposerHint();
  updateSidebar(
    approved
      ? `Approval granted: ${toolName}`
      : `Approval denied: ${toolName}`
  );
  renderer.requestRender();
  scrollToBottom();
  resolve(approved);
}

async function requestToolApproval(
  toolName: string,
  argumentsObject: Record<string, unknown>
) {
  if (pendingApproval) {
    throw new Error("Another approval is already pending.");
  }

  appendEntry(
    "system",
    [
      `Approval required before running \`${toolName}\`.`,
      "",
      "Press `y` to approve or `n` / `Esc` to deny.",
      "",
      "Arguments:",
      formatApprovalArguments(argumentsObject),
    ].join("\n")
  );
  updateComposerHint();
  updateSidebar(`Approval required: ${toolName} (y approve, n deny)`);
  renderer.requestRender();
  scrollToBottom();

  return await new Promise<boolean>((resolve) => {
    pendingApproval = {
      toolName,
      resolve,
    };
  });
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

function setMode(nextMode: Mode) {
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
    input.placeholder = "Press i to insert or : for commands";
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

function updateSidebar(note = "Ready for your next prompt.") {
  sidebarText.content = [
    `Status: ${busy ? "streaming" : "idle"}`,
    `Mode: ${mode}`,
    `Messages: ${entries.length}`,
    "",
    "Shortcuts",
    "i      insert mode",
    ":      command mode",
    "j / k  scroll transcript",
    "Esc    normal mode",
    "Ctrl+C quit",
    "",
    "Commands",
    ":clear reset conversation",
    ":quit  exit UI",
    "",
    "Backend",
    BACKEND_URL,
    "",
    note,
  ].join("\n");
}

function updateComposerHint() {
  if (pendingApproval) {
    composerHint.content = "Approval pending. Press y to approve or n/Esc to deny.";
    return;
  }

  if (busy) {
    composerHint.content = "The agent is responding. Use j and k to inspect earlier messages.";
    return;
  }

  if (mode === "normal") {
    composerHint.content =
      "Normal mode. Press i to compose, : for commands, or j/k to scroll.";
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

function executeCommand(raw: string) {
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
    renderer.destroy();
    return;
  }

  updateSidebar(`Unknown command: :${command}`);
  commandDraft = "";
  setMode("normal");
}

async function submitPrompt() {
  if (busy) return;

  if (mode === "command") {
    executeCommand(commandDraft);
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

  try {
    let run = true;
    let sawAssistantOutput = false;

    while (run) {
      const stream = await streamResponse({
        messages: conversation,
        tools,
      });

      let assistantEntry: ChatEntry | null = null;
      let assistantContent = "";
      const toolCalls: ToolCall[] = [];

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
        })
      );

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
        conversation.push(await executeToolCall(toolCall, loadedTools));
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendEntry("error", `Request failed.\n\n${message}`);
    updateSidebar("Request failed. Check that the local backend is running.");
  } finally {
    busy = false;
    updateComposerHint();
    updateSidebar("Ready for your next prompt.");
    renderer.requestRender();
    scrollToBottom();
  }
}

function isColonKey(key: KeyEvent) {
  return key.sequence === ":" || (key.shift && key.name === ";");
}

function handleGlobalKey(key: KeyEvent) {
  if (key.ctrl && key.name === "c") {
    renderer.destroy();
    return;
  }

  if (pendingApproval) {
    if (key.eventType === "repeat") {
      return;
    }

    if (key.name === "y") {
      settlePendingApproval(true);
    } else if (key.name === "n" || key.name === "escape") {
      settlePendingApproval(false);
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

updateComposerHint();
updateSidebar();
setMode("normal");

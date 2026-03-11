import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { generateTextResponse, streamResponse, type Message, type Tool } from "../llm.ts";
import { indexSkills } from "../skills-index.ts";
import { MODEL_PRESETS, ROOT_AGENTS_PATH, WORKSPACE_ROOT } from "./constants.ts";
import { getActiveWorkspaceRoot, mergeSourceIntoWorktree } from "../../worktree.ts";
import { buildConversationSummaryPrompt, createSummarizedConversationState, hasMeaningfulTranscript } from "./summarize.ts";
import { resolveModelCommand } from "./model-menu.ts";
import { appendChunkWithLimit, extractAssistantText } from "./utils.ts";
import type { AgentsContextResult, ConversationMessage, LoadedTool, PersistedTranscriptEntry } from "./types.ts";

export function describeHelpOptions(currentModel: string) {
  return [
    "Available commands",
    "",
    ":help       show available commands",
    ":agents-md  create or update the workspace AGENTS.md",
    ":clear      reset the current conversation",
    ":history    open saved conversation history",
    ":index      embed and refresh skill chunks",
    ":model      open the searchable model picker",
    ":model ...  switch to a preset or explicit model id",
    ":plan       show the current .agents/PLAN.md",
    ":merge      merge the source branch or ref into the active worktree",
    ":merge ...  merge an explicit git ref, or remote plus branch, into the active worktree",
    ":summarize  compress the current chat history",
    ":worktree   copy the active absolute workspace/worktree path",
    ":quit       exit the UI",
    "",
    describeModelOptions(currentModel),
  ].join("\n");
}

export function buildAgentsMdSystemPrompt() {
  return [
    "You are a focused sub-agent that generates the repository's root AGENTS.md content.",
    "",
    "You do not edit files directly. Your only job is to inspect the repository with the allowed tools and then call `create_agents_context` exactly once with the final markdown.",
    "",
    "Tool constraints:",
    "- You only have read-only discovery tools plus `create_agents_context`.",
    "- Do not attempt file edits, shell commands, or any write action.",
    "- End the loop by calling `create_agents_context` with the full AGENTS.md content.",
    "",
    "Primary goal:",
    "- Produce a compact, high-signal AGENTS.md rooted in facts discoverable from the repository.",
    "",
    "Required outcomes:",
    "- Create content suitable for the repository root AGENTS.md file.",
    "- Preserve and incorporate any existing AGENTS.md guidance that is still accurate and useful.",
    "- Prefer merging and refining over replacing wholesale unless the current file is clearly low-quality or obsolete.",
    "",
    "Use the available tools to inspect the repository before finalizing. Do not guess.",
    "",
    "Initial context is already provided via:",
    "- the standard repository system prompt",
    "- an initial `list_project_tree` call",
    "- an initial `read_file` of `package.json`",
    "- an initial `read_file` of `AGENTS.md` when available",
    "",
    "Suggested workflow:",
    "1. Inspect package manifests, README/docs, and a small curated repository tree.",
    "2. Identify canonical install, run, test, lint, typecheck, and build commands.",
    "3. Infer the repo map and major subsystems from actual files.",
    "4. Extract important invariants, workflows, and sharp edges from code and docs.",
    "5. Read any existing AGENTS.md and preserve project-specific guidance that remains valid.",
    "6. Call `create_agents_context` with a concise AGENTS.md markdown document.",
    "",
    "Target content budget:",
    "- Aim for roughly 80-200 lines.",
    "- Keep it dense and practical.",
    "- Prefer bullets over prose.",
    "",
    "Prioritize these sections when information is available:",
    "- Project Summary",
    "- Standard Commands",
    "- Repo Map",
    "- Important Invariants",
    "- Preferred Patterns",
    "- Change Policy",
    "- Validation",
    "- Environment / Services",
    "- Sharp Edges",
    "- Glossary or Active Migrations if they are clearly supported by evidence",
    "",
    "Quality bar:",
    "- Be specific, not generic.",
    "- Distinguish confirmed facts from cautious inferences.",
    "- Do not invent commands, architecture, or policies.",
    "- If something is unknown, omit it rather than speculate.",
    "- Mention generated files or machine-managed paths when relevant.",
    "- Call out validation commands that should be run after edits.",
    "",
    "Output requirements:",
    "- The `markdown` field passed to `create_agents_context` must be the complete AGENTS.md file contents.",
    "- Write polished markdown with short headings and concise bullets.",
    "- Keep the document useful to another agent, not promotional to humans.",
    "- Avoid copying large README sections verbatim.",
    "",
    "Stop condition:",
    "- Finish only by calling `create_agents_context` once you have the final AGENTS.md content.",
  ].join("\n");
}

function buildAgentsMdReadonlyTools(loadedTools: Map<string, LoadedTool>): Tool[] {
  const readonlyToolNames = new Set([
    "list_project_tree",
    "read_file",
    "search_skills",
    "web_fetch",
    "web_search",
    "ripgrep",
    "ast-grep",
    "create_agents_context",
  ]);

  return Array.from(loadedTools.values(), (tool) => tool.definition.name)
    .filter((name) => readonlyToolNames.has(name))
    .map((name) => {
      const tool = loadedTools.get(name);
      if (!tool) {
        throw new Error(`Missing required AGENTS.md tool: ${name}`);
      }

      return {
        name: tool.definition.name,
        description: tool.definition.description,
        inputSchema: tool.definition.inputSchema,
        execute: async (input: unknown) =>
          tool.execute(typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}),
      } satisfies Tool;
    });
}

function parseAgentsContextResult(output: unknown): AgentsContextResult | null {
  if (typeof output !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(output) as { markdown?: unknown };
    return typeof parsed.markdown === "string" ? { markdown: parsed.markdown } : null;
  } catch {
    return null;
  }
}

async function writeAgentsMd(markdown: string) {
  const normalized = markdown.trim() ? `${markdown.trimEnd()}\n` : "";
  await fs.writeFile(ROOT_AGENTS_PATH, normalized, "utf-8");
}

export async function runAgentsMdCommand(options: {
  busy: boolean;
  currentModel: string;
  loadedTools: Map<string, LoadedTool>;
  initialSystemMessage: string;
  initialToolMessages: ConversationMessage[];
  setCommandDraft: (value: string) => void;
  setBusy: (busy: boolean) => void;
  setModeNormal: () => void;
  startThinkingIndicator: (note: string) => void;
  stopThinkingIndicator: () => void;
  updateSidebar: (note: string) => void;
  appendSystemMessage: (content: string) => void;
  appendEntry: (role: "error", content: string) => void;
  updateComposerHint: () => void;
  requestRender: () => void;
  scrollToBottom: (force?: boolean) => void;
}) {
  if (options.busy) {
    options.updateSidebar(
      "Wait for the current stream or shell command to finish before generating AGENTS.md."
    );
    options.requestRender();
    return;
  }

  options.setCommandDraft("");
  options.setBusy(true);
  options.setModeNormal();
  options.startThinkingIndicator(`Generating AGENTS.md with ${options.currentModel}...`);
  options.updateSidebar(`Generating AGENTS.md with ${options.currentModel}...`);
  options.updateComposerHint();
  options.requestRender();
  options.scrollToBottom(true);

  const tools = buildAgentsMdReadonlyTools(options.loadedTools);
  const conversation: Message[] = [
    {
      role: "system",
      content: [options.initialSystemMessage, buildAgentsMdSystemPrompt()]
        .filter((part) => part.trim())
        .join("\n\n"),
    },
    ...options.initialToolMessages,
    {
      role: "user",
      content: "Create or update the repository root AGENTS.md by inspecting the repository and then calling `create_agents_context` with the final markdown.",
    },
  ];

  let assistantText = "";
  let finalMarkdown: string | null = null;

  try {
    const result = streamResponse({
      model: options.currentModel,
      messages: conversation,
      tools,
    });

    for await (const chunk of result.stream) {
      switch (chunk.type) {
        case "reasoning":
          options.updateSidebar("AGENTS.md sub-agent is reasoning...");
          break;
        case "content": {
          options.stopThinkingIndicator();
          const nextText = appendChunkWithLimit(assistantText, chunk.content);
          assistantText = nextText.value;
          break;
        }
        case "tool-call-start":
          options.stopThinkingIndicator();
          options.updateSidebar(`AGENTS.md sub-agent requested ${chunk.toolName}...`);
          break;
        case "tool-call-delta":
          options.stopThinkingIndicator();
          options.updateSidebar(`AGENTS.md sub-agent is preparing ${chunk.toolName} input...`);
          break;
        case "tool-result": {
          options.stopThinkingIndicator();
          if (chunk.toolName === "create_agents_context") {
            const parsed = parseAgentsContextResult(chunk.output);
            if (!parsed) {
              throw new Error("create_agents_context returned an invalid result.");
            }
            finalMarkdown = parsed.markdown;
          }
          break;
        }
      }
    }

    const responseMessages = await result.responseMessages;
    conversation.push(...responseMessages);

    if (!finalMarkdown) {
      const fallbackText = extractAssistantText(responseMessages).trim() || assistantText.trim();
      throw new Error(
        fallbackText
          ? `AGENTS.md sub-agent finished without calling create_agents_context.\n\nLast assistant output:\n${fallbackText}`
          : "AGENTS.md sub-agent finished without calling create_agents_context."
      );
    }

    await writeAgentsMd(finalMarkdown);
    options.appendSystemMessage(
      [
        `Created or updated \`${path.relative(WORKSPACE_ROOT, ROOT_AGENTS_PATH) || "AGENTS.md"}\`.`,
        "",
        "The AGENTS.md sub-agent completed using read-only discovery tools and returned final markdown via `create_agents_context`.",
      ].join("\n")
    );
    options.updateSidebar("AGENTS.md updated.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.appendEntry("error", `AGENTS.md generation failed.\n\n${message}`);
    options.updateSidebar("AGENTS.md generation failed.");
  } finally {
    options.stopThinkingIndicator();
    options.setBusy(false);
    options.updateComposerHint();
    options.requestRender();
    options.scrollToBottom(true);
  }
}

export function describeModelOptions(currentModel: string) {
  const presetLines = Object.entries(MODEL_PRESETS).map(
    ([name, modelId]) => `:model ${name.padEnd(10, " ")} ${modelId}`
  );

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

export async function summarizeConversationCommand(options: {
  busy: boolean;
  currentModel: string;
  transcriptHistory: PersistedTranscriptEntry[];
  setCommandDraft: (value: string) => void;
  setBusy: (busy: boolean) => void;
  setModeNormal: () => void;
  startThinkingIndicator: (note: string) => void;
  sendStreamStateEvent: (event: "start-connection" | "connection-established" | "receive-reasoning" | "receive-content" | "await-approval" | "approval-resolved" | "complete" | "reset") => void;
  updateSidebar: (note: string) => void;
  appendSystemMessage: (content: string) => void;
  appendEntry: (role: "error", content: string) => void;
  restoreTranscriptFromHistory: () => void;
  persistActiveConversation: () => Promise<void>;
  updateComposerHint: () => void;
  requestRender: () => void;
  scrollToBottom: (force?: boolean) => void;
  replaceWithSummarizedState: (state: {
    conversation: ConversationMessage[];
    transcript: PersistedTranscriptEntry[];
  }) => void;
  createInitialConversationMessages: () => ConversationMessage[];
}) {
  if (options.busy) {
    options.updateSidebar(
      "Wait for the current stream or shell command to finish before summarizing."
    );
    options.requestRender();
    return;
  }

  if (!hasMeaningfulTranscript(options.transcriptHistory)) {
    options.appendSystemMessage("Nothing to summarize yet.");
    options.setCommandDraft("");
    options.setModeNormal();
    return;
  }

  options.setCommandDraft("");
  options.setBusy(true);
  options.sendStreamStateEvent("start-connection");
  options.setModeNormal();
  options.startThinkingIndicator(`Summarizing conversation with ${options.currentModel}...`);
  options.sendStreamStateEvent("connection-established");
  options.updateSidebar(`Summarizing conversation with ${options.currentModel}...`);

  try {
    const summary = await generateTextResponse({
      model: options.currentModel,
      messages: [
        {
          role: "system",
          content:
            "You compress chat history for an agent. Preserve only non-recoverable context needed to continue the task well. Be concise and reliable.",
        },
        {
          role: "user",
          content: buildConversationSummaryPrompt(options.transcriptHistory),
        },
      ],
    });

    if (!summary) {
      options.appendEntry(
        "error",
        "Conversation summarization returned an empty response. The existing chat history was left unchanged."
      );
      options.updateSidebar("Conversation summarization returned an empty response.");
      return;
    }

    options.replaceWithSummarizedState(
      createSummarizedConversationState({
        summary,
        createInitialConversationMessages: options.createInitialConversationMessages,
      })
    );
    options.restoreTranscriptFromHistory();
    await options.persistActiveConversation();
    options.updateSidebar("Conversation summarized and compressed.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.appendEntry(
      "error",
      `Conversation summarization failed. Existing history was left unchanged.\n\n${message}`
    );
    options.updateSidebar("Conversation summarization failed.");
  } finally {
    options.setBusy(false);
    options.updateComposerHint();
    options.requestRender();
    options.scrollToBottom(true);
  }
}

export async function showPlanCommand(options: {
  planPath: string;
  setCommandDraft: (value: string) => void;
  setModeNormal: () => void;
  appendSystemMessage: (content: string) => void;
  appendEntry: (role: "error", content: string) => void;
  updateSidebar: (note: string) => void;
}) {
  options.setCommandDraft("");
  options.setModeNormal();

  const displayPath =
    path.relative(getActiveWorkspaceRoot(), options.planPath) || ".agents/PLAN.md";

  try {
    const content = await fs.readFile(options.planPath, "utf8");
    const trimmed = content.trim();
    options.appendSystemMessage(
      trimmed
        ? `Current ${displayPath}\n\n${trimmed}`
        : `Current ${displayPath} is empty.`
    );
    options.updateSidebar(`Displayed current ${displayPath}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.appendEntry("error", `Failed to read ${displayPath}.\n\n${message}`);
    options.updateSidebar(`Failed to read ${displayPath}.`);
  }
}

async function spawnClipboardCommand(command: string, args: string[], input: string) {
  return await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if ((code ?? 0) === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${code ?? 0}.`));
    });

    child.stdin?.end(input);
  });
}

export async function copyWorktreePathCommand(options: {
  worktreePath: string;
  setCommandDraft: (value: string) => void;
  setModeNormal: () => void;
  appendSystemMessage: (content: string) => void;
  appendEntry: (role: "error", content: string) => void;
  updateSidebar: (note: string) => void;
}) {
  options.setCommandDraft("");
  options.setModeNormal();

  const platform = process.platform;

  try {
    if (platform === "darwin") {
      await spawnClipboardCommand("pbcopy", [], options.worktreePath);
    } else if (platform === "win32") {
      await spawnClipboardCommand("clip", [], options.worktreePath);
    } else {
      try {
        await spawnClipboardCommand("wl-copy", [], options.worktreePath);
      } catch {
        await spawnClipboardCommand("xclip", ["-selection", "clipboard"], options.worktreePath);
      }
    }

    options.appendSystemMessage(`Copied active workspace path to clipboard.\n\n\`${options.worktreePath}\``);
    options.updateSidebar("Copied active workspace path to clipboard.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.appendEntry(
      "error",
      `Failed to copy the active workspace path to the clipboard.\n\nPath:\n\`${options.worktreePath}\`\n\n${message}`
    );
    options.updateSidebar("Failed to copy active workspace path to clipboard.");
  }
}

export async function runMergeWorktreeCommand(options: {
  argument: string;
  setCommandDraft: (value: string) => void;
  setModeNormal: () => void;
  appendSystemMessage: (content: string) => void;
  appendEntry: (role: "error", content: string) => void;
  updateSidebar: (note: string) => void;
}) {
  options.setCommandDraft("");
  options.setModeNormal();

  const trimmed = options.argument.trim();
  const tokens = trimmed ? trimmed.split(/\s+/).filter(Boolean) : [];

  const mergeOptions =
    tokens.length === 0
      ? undefined
      : tokens.length === 1
        ? { sourceRef: tokens[0] }
        : tokens.length === 2
          ? { remote: tokens[0], branch: tokens[1] }
          : null;

  if (mergeOptions === null) {
    options.appendEntry(
      "error",
      [
        "Invalid merge arguments.",
        "",
        "Usage:",
        "- :merge",
        "- :merge origin/main",
        "- :merge origin main",
      ].join("\n")
    );
    options.updateSidebar("Invalid merge arguments.");
    return;
  }

  try {
    const message = await mergeSourceIntoWorktree(mergeOptions);
    options.appendSystemMessage(message);
    options.updateSidebar("Merged source changes into the active worktree.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.appendEntry("error", `Worktree merge failed.\n\n${message}`);
    options.updateSidebar("Worktree merge failed.");
  }
}

export async function runIndexCommand(options: {
  setCommandDraft: (value: string) => void;
  setBusy: (busy: boolean) => void;
  setModeNormal: () => void;
  updateSidebar: (note: string) => void;
  appendSystemMessage: (content: string) => void;
  appendEntry: (role: "error", content: string) => void;
  updateComposerHint: () => void;
  requestRender: () => void;
}) {
  options.setCommandDraft("");
  options.setBusy(true);
  options.setModeNormal();
  options.updateSidebar("Indexing skill files with embeddings...");

  try {
    const index = await indexSkills(WORKSPACE_ROOT);
    options.appendSystemMessage(
      [
        `Indexed ${index.chunks.length} skill chunk${index.chunks.length === 1 ? "" : "s"}.`,
        `Skill files: ${new Set(index.chunks.map((chunk) => chunk.path)).size}.`,
        `Saved embeddings to \`.agents/skills-index.json\`.`,
        `Embedding model: \`${index.embeddingModel}\`.`,
      ].join("\n")
    );
    options.updateSidebar("Skill index refreshed.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.appendEntry("error", `Skill indexing failed.\n\n${message}`);
    options.updateSidebar("Skill indexing failed.");
  } finally {
    options.setBusy(false);
    options.updateComposerHint();
    options.requestRender();
  }
}

export function resolveRequestedModel(argument: string) {
  return resolveModelCommand({
    input: argument,
    presets: MODEL_PRESETS,
  });
}

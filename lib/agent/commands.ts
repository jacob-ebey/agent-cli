import * as fs from "node:fs/promises";

import { generateTextResponse } from "../llm.ts";
import { indexSkills } from "../skills-index.ts";
import { MODEL_PRESETS, WORKSPACE_ROOT } from "./constants.ts";
import { buildConversationSummaryPrompt, createSummarizedConversationState, hasMeaningfulTranscript } from "./summarize.ts";
import { resolveModelCommand } from "./model-menu.ts";
import type { ConversationMessage, PersistedTranscriptEntry } from "./types.ts";

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
  options.setModeNormal();
  options.startThinkingIndicator(`Summarizing conversation with ${options.currentModel}...`);
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

  try {
    const content = await fs.readFile(options.planPath, "utf8");
    const trimmed = content.trim();
    options.appendSystemMessage(
      trimmed ? `Current PLAN.md\n\n${trimmed}` : "Current PLAN.md is empty."
    );
    options.updateSidebar("Displayed current PLAN.md.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.appendEntry("error", `Failed to read PLAN.md.\n\n${message}`);
    options.updateSidebar("Failed to read PLAN.md.");
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

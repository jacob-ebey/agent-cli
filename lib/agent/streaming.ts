import { TextRenderable } from "@opentui/core";

import type { Message, ResponseChunk, Tool } from "../llm.ts";
import { streamResponse } from "../llm.ts";
import type {
  AssistantStreamState,
  ChatEntry,
  ConversationMessage,
  PersistedTranscriptEntry,
} from "./types.ts";
import type { StreamStateMachineEvent } from "./stream-state.ts";
import {
  extractAssistantText,
  formatToolOutput,
  lastAssistantResponseContainsToolCall,
} from "./utils.ts";

export function createAssistantStreamState(): AssistantStreamState {
  return {
    entry: null,
    textBody: null,
    content: "",
    transcriptIndex: null,
    sawOutput: false,
    sawToolActivity: false,
    insertAfterEntryId: null,
    totalTokensUsed: null,
  };
}

export function ensureAssistantStreamEntry({
  state,
  appendEntry,
  transcriptHistory,
}: {
  state: AssistantStreamState;
  appendEntry: (
    role: "assistant",
    content: string,
    options: { recordInTranscript: false; insertBeforeEntryId?: string }
  ) => ChatEntry;
  transcriptHistory: PersistedTranscriptEntry[];
}): ChatEntry {
  if (state.entry) {
    return state.entry;
  }

  const entry = appendEntry("assistant", "", {
    recordInTranscript: false,
    insertBeforeEntryId: state.insertAfterEntryId ?? undefined,
  });
  state.entry = entry;
  if (entry.renderKind !== "text") {
    throw new Error("Assistant stream entry body must be text renderable.");
  }
  state.textBody = entry.body as TextRenderable;
  state.transcriptIndex =
    transcriptHistory.push({
      role: "assistant",
      content: "",
    }) - 1;
  return entry;
}

export function appendAssistantStreamContent({
  state,
  contentChunk,
  transcriptHistory,
  ensureEntry,
  stopThinkingIndicator,
  requestRender,
  scrollToBottom,
}: {
  state: AssistantStreamState;
  contentChunk: string;
  transcriptHistory: PersistedTranscriptEntry[];
  ensureEntry: () => ChatEntry;
  stopThinkingIndicator: () => void;
  requestRender: () => void;
  scrollToBottom: () => void;
}) {
  stopThinkingIndicator();
  ensureEntry();
  state.content += contentChunk;
  if (!state.textBody) {
    throw new Error("Assistant stream entry body must be text renderable while streaming.");
  }
  state.textBody.content = state.content || " ";
  if (state.transcriptIndex !== null) {
    transcriptHistory[state.transcriptIndex] = {
      role: "assistant",
      content: state.content,
    };
  }
  state.sawOutput = true;
  requestRender();
  scrollToBottom();
}

export async function handleResponseChunk({
  chunk,
  state,
  startThinkingIndicator,
  activeThinking,
  stopThinkingIndicator,
  updateSidebar,
  sendStreamStateEvent,
  appendAssistantContent,
  appendSystemMessage,
  summarizeToolResult,
  refreshUpmergeState,
}: {
  chunk: ResponseChunk;
  state: AssistantStreamState;
  startThinkingIndicator: (note: string) => void;
  activeThinking: boolean;
  stopThinkingIndicator: () => void;
  updateSidebar: (note: string) => void;
  sendStreamStateEvent: (event: StreamStateMachineEvent) => void;
  appendAssistantContent: (contentChunk: string) => Promise<void>;
  appendSystemMessage: (content: string) => Promise<string>;
  summarizeToolResult: (toolName: string, input: unknown, output: unknown) => string | null;
  refreshUpmergeState: () => Promise<void>;
}) {
  switch (chunk.type) {
    case "reasoning":
      sendStreamStateEvent("receive-reasoning");
      if (!activeThinking) {
        startThinkingIndicator("Model is reasoning...");
      }
      updateSidebar("Model is reasoning...");
      break;
    case "content":
      sendStreamStateEvent("receive-content");
      await appendAssistantContent(chunk.content);
      break;
    case "tool-call-start":
      state.sawToolActivity = true;
      sendStreamStateEvent("receive-reasoning");
      stopThinkingIndicator();
      updateSidebar(`Tool requested: ${chunk.toolName}`);
      break;
    case "tool-call-delta":
      state.sawToolActivity = true;
      sendStreamStateEvent("receive-reasoning");
      stopThinkingIndicator();
      updateSidebar(`Preparing tool input: ${chunk.toolName}`);
      break;
    case "tool-result": {
      state.sawToolActivity = true;
      stopThinkingIndicator();
      const systemEntryId = await appendSystemMessage(
        summarizeToolResult(chunk.toolName, chunk.input, chunk.output) ??
          [`Tool \`${chunk.toolName}\` completed.`, "", formatToolOutput(chunk.output)].join(
            "\n"
          )
      );
      if (state.entry) {
        state.insertAfterEntryId = systemEntryId;
      }
      await refreshUpmergeState();
      updateSidebar(`Tool completed: ${chunk.toolName}`);
      break;
    }
    case "finish":
      state.totalTokensUsed = chunk.totalUsage.totalTokens ?? null;
      break;
  }
}

export function applyFinalAssistantTextIfNeeded({
  state,
  responseMessages,
  appendEntry,
}: {
  state: AssistantStreamState;
  responseMessages: Message[];
  appendEntry: (role: "assistant", content: string) => void;
}) {
  if (state.content.trim() || state.sawOutput) {
    return;
  }

  const finalAssistantText = extractAssistantText(responseMessages);
  if (!finalAssistantText.trim()) {
    return;
  }

  appendEntry("assistant", finalAssistantText);
  state.sawOutput = true;
  state.content = finalAssistantText;
}

export function shouldContinueAfterResponse(
  state: AssistantStreamState,
  responseMessages: Message[],
  appendEntry: (role: "assistant", content: string) => void
) {
  const hasToolCall = lastAssistantResponseContainsToolCall(responseMessages);

  if (!state.content.trim() && !state.sawOutput && !state.sawToolActivity && !hasToolCall) {
    appendEntry("assistant", "The model returned an empty response. Try another prompt.");
    return false;
  }

  return hasToolCall;
}

export async function runSingleAgentTurn({
  model,
  conversation,
  tools,
  createAbortController,
  onAbortControllerCreated,
  onAbortControllerCleared,
  createState,
  onChunk,
  onResponseMessages,
  onAborted,
}: {
  model: string;
  conversation: ConversationMessage[];
  tools: Tool[];
  createAbortController: () => AbortController;
  onAbortControllerCreated: (controller: AbortController) => void;
  onAbortControllerCleared: (controller: AbortController) => void;
  createState: () => AssistantStreamState;
  onChunk: (chunk: ResponseChunk, state: AssistantStreamState) => Promise<void>;
  onResponseMessages: (responseMessages: Message[], state: AssistantStreamState) => Promise<boolean>;
  onAborted: () => void;
}) {
  const streamAbortController = createAbortController();
  onAbortControllerCreated(streamAbortController);
  const assistantState = createState();

  try {
    const result = streamResponse({
      model,
      messages: conversation,
      tools,
      abortSignal: streamAbortController.signal,
    });

    for await (const chunk of result.stream) {
      await onChunk(chunk, assistantState);
    }

    const responseMessages = await result.responseMessages;
    conversation.push(...responseMessages);

    return {
      shouldContinue: await onResponseMessages(responseMessages, assistantState),
      aborted: false,
    };
  } catch (error) {
    if (
      streamAbortController.signal.aborted ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      onAborted();
      return {
        shouldContinue: false,
        aborted: true,
      };
    }
    throw error;
  } finally {
    onAbortControllerCleared(streamAbortController);
  }
}

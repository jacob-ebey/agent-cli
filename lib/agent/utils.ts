import type { Message } from "../llm.ts";

import { SHELL_OUTPUT_CHAR_LIMIT } from "./constants.ts";

export function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function appendChunkWithLimit(current: string, chunk: string) {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function formatToolOutput(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function readStringArgument(
  argumentsObject: Record<string, unknown>,
  key: string
) {
  const value = argumentsObject[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function readIntegerArgument(
  argumentsObject: Record<string, unknown>,
  key: string
) {
  const value = argumentsObject[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

export function matchOutputLabel(output: unknown, label: string) {
  if (typeof output !== "string") {
    return null;
  }

  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = output.match(new RegExp(`^${escapedLabel}:\\s+(.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}

export function extractTextParts(content: unknown): string[] {
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

export function extractAssistantText(messages: Message[]) {
  return messages
    .flatMap((message) => {
      if (message.role !== "assistant") {
        return [];
      }

      return extractTextParts((message as { content?: unknown }).content);
    })
    .join("");
}

export function assistantMessageContainsToolCall(message: Message) {
  if (message.role !== "assistant") {
    return false;
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((part) => {
    if (typeof part !== "object" || part === null) {
      return false;
    }

    return (part as { type?: unknown }).type === "tool-call";
  });
}

export function lastAssistantResponseContainsToolCall(messages: Message[]) {
  let sawToolMessageAfterAssistant = false;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message.role === "tool") {
      sawToolMessageAfterAssistant = true;
      continue;
    }

    if (message.role === "assistant") {
      return assistantMessageContainsToolCall(message) || sawToolMessageAfterAssistant;
    }
  }

  return false;
}

export function formatConversationTimestamp(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export function buildConversationPreview(entries: Array<{ role: string; content: string }>) {
  if (!entries.length) {
    return "This conversation has no visible transcript.";
  }

  return entries
    .map((entry) => {
      const heading = entry.role[0].toUpperCase() + entry.role.slice(1);
      return `${heading}\n${entry.content}`;
    })
    .join("\n\n");
}

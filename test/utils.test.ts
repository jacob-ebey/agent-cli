import { expect, test } from "bun:test";

import type { Message } from "../lib/llm.ts";
import {
  appendChunkWithLimit,
  assistantMessageContainsToolCall,
  buildConversationPreview,
  extractAssistantText,
  extractTextParts,
  formatToolOutput,
  isRecord,
  lastAssistantResponseContainsToolCall,
  matchOutputLabel,
  normalizeWhitespace,
  readIntegerArgument,
  readStringArgument,
} from "../lib/agent/utils.ts";

test("normalizeWhitespace collapses runs and trims", () => {
  expect(normalizeWhitespace("  hello\n\t world  ")).toBe("hello world");
});

test("appendChunkWithLimit appends until the shared limit", () => {
  const appended = appendChunkWithLimit("abc", "def");
  expect(appended).toEqual({ value: "abcdef", truncated: false });

  const limitSized = "x".repeat(64_000);
  expect(appendChunkWithLimit(limitSized, "y")).toEqual({
    value: limitSized,
    truncated: true,
  });
});

test("isRecord distinguishes plain objects from arrays and null", () => {
  expect(isRecord({ ok: true })).toBe(true);
  expect(isRecord([1, 2, 3])).toBe(false);
  expect(isRecord(null)).toBe(false);
});

test("formatToolOutput serializes objects and preserves strings", () => {
  expect(formatToolOutput("plain")).toBe("plain");
  expect(formatToolOutput({ a: 1 })).toBe('{\n  "a": 1\n}');
});

test("argument readers validate strings and integers", () => {
  expect(readStringArgument({ path: "  file.ts  " }, "path")).toBe("file.ts");
  expect(readStringArgument({ path: "   " }, "path")).toBeNull();
  expect(readIntegerArgument({ limit: 10 }, "limit")).toBe(10);
  expect(readIntegerArgument({ limit: 10.5 }, "limit")).toBeNull();
});

test("matchOutputLabel returns the labeled value", () => {
  const output = "Command: echo hi\nExit code: 0\n";
  expect(matchOutputLabel(output, "Exit code")).toBe("0");
  expect(matchOutputLabel(output, "Missing")).toBeNull();
});

test("extractTextParts and extractAssistantText ignore non-text content", () => {
  const content: NonNullable<Message["content"]> = [
    { type: "text", text: "hello" },
    {
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "read_file",
      input: {},
    },
    { type: "text", text: " world" },
  ];
  expect(extractTextParts(content)).toEqual(["hello", " world"]);
  expect(
    extractAssistantText([
      { role: "user", content: "ignore" } as Message,
      { role: "assistant", content } as Message,
      { role: "assistant", content: " tail" } as Message,
    ])
  ).toBe("hello world tail");
});

test("tool-call detectors find the last assistant tool call", () => {
  expect(
    assistantMessageContainsToolCall({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "read_file",
          input: {},
        },
      ],
    } as Message)
  ).toBe(true);

  expect(
    lastAssistantResponseContainsToolCall([
      { role: "assistant", content: "text only" } as Message,
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-2",
            toolName: "read_file",
            input: {},
          },
        ],
      } as Message,
    ])
  ).toBe(true);

  expect(
    lastAssistantResponseContainsToolCall([{ role: "user", content: "hi" } as Message])
  ).toBe(false);
});

test("buildConversationPreview formats entries and handles empty state", () => {
  expect(
    buildConversationPreview([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ])
  ).toBe("User\nHello\n\nAssistant\nHi");
  expect(buildConversationPreview([])).toBe(
    "This conversation has no visible transcript."
  );
});

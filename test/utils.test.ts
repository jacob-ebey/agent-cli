import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  applyConstraintUpdates,
  checkManualShellConstraints,
  checkToolConstraints,
  createSessionConstraintState,
  formatConstraintsSummary,
  parseConstraintsCommand,
  recordSuccessfulEdit,
  recordSuccessfulShellCommand,
} from "../lib/agent/constraints.ts";
import { matchesApprovedShellCommandPattern } from "../lib/agent/approvals.ts";
import { buildCritiquePrompt, buildReviewPrompt } from "../lib/agent/commands.ts";

import type { ResponseChunk, Message } from "../lib/llm.ts";
import {
  createAssistantStreamState,
  handleResponseChunk,
} from "../lib/agent/streaming.ts";
import {
  applyStreamStateEvent,
  type StreamStateMachineEvent,
} from "../lib/agent/stream-state.ts";
import type { StreamPhase } from "../lib/agent/types.ts";
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

test("constraints command parsing and formatting support show reset and updates", () => {
  expect(parseConstraintsCommand("")).toEqual({ kind: "show" });
  expect(parseConstraintsCommand("reset")).toEqual({ kind: "reset" });
  expect(parseConstraintsCommand("read-only=true shell=deny max-files=2 require-validation=true")).toEqual({
    kind: "update",
    updates: {
      readOnly: true,
      shellPolicy: "deny",
      maxFiles: 2,
      requireValidation: true,
    },
  });

  expect(
    formatConstraintsSummary(
      applyConstraintUpdates(createSessionConstraintState().constraints, {
        readOnly: true,
        networkPolicy: "deny",
      })
    )
  ).toBe("read-only=true, shell=ask, network=deny, max-files=none, require-validation=false");
});

test("constraint enforcement blocks edits shell and network when configured", () => {
  const state = createSessionConstraintState();
  state.constraints.readOnly = true;
  expect(
    checkToolConstraints({
      toolName: "apply-patch",
      targetPath: "/tmp/example.ts",
      state,
    })
  ).toContain("read-only mode");

  state.constraints.readOnly = false;
  state.constraints.shellPolicy = "deny";
  expect(checkManualShellConstraints(state)).toContain("shell=deny");
  expect(
    checkToolConstraints({
      toolName: "run_shell_command",
      targetPath: null,
      state,
    })
  ).toContain("shell=deny");

  state.constraints.networkPolicy = "deny";
  expect(
    checkToolConstraints({
      toolName: "web_fetch",
      targetPath: null,
      state,
    })
  ).toContain("network=deny");
});

test("max-files and validation tracking work across edits and validation commands", () => {
  const state = createSessionConstraintState();
  state.constraints.maxFiles = 1;

  recordSuccessfulEdit("/tmp/one.ts", state);
  expect(state.validationFresh).toBe(false);
  expect(
    checkToolConstraints({
      toolName: "apply-patch",
      targetPath: "/tmp/two.ts",
      state,
    })
  ).toContain("max-files=1");

  recordSuccessfulShellCommand("bun typecheck", state);
  expect(state.validationFresh).toBe(true);
});

test("critique and review prompts include the expected framing", () => {
  expect(buildCritiquePrompt("review this api")).toContain("Strongest objections");
  expect(
    buildReviewPrompt({
      constraints: createSessionConstraintState().constraints,
      validationFresh: false,
      editedFiles: ["lib/agent/commands.ts"],
      upmergeMode: "worktree",
      upmergeNote: "Agent edits are isolated.",
      pendingPaths: ["lib/agent/commands.ts"],
    })
  ).toContain("Risk areas");
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

test("shell approval patterns support exact and trailing wildcard matches", () => {
  expect(matchesApprovedShellCommandPattern("bun typecheck", "bun typecheck")).toBe(true);
  expect(matchesApprovedShellCommandPattern("bun typecheck", "bun typecheck --watch")).toBe(false);
  expect(matchesApprovedShellCommandPattern("bun test*", "bun test")).toBe(true);
  expect(
    matchesApprovedShellCommandPattern(
      "bun test*",
      "bun test test/event-stream-decoder.test.ts"
    )
  ).toBe(true);
  expect(matchesApprovedShellCommandPattern("bun test*", "bunx test")).toBe(false);
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

test("stream phase leaves connecting on first tool activity", async () => {
  let streamPhase: StreamPhase = "connecting";
  const events: StreamStateMachineEvent[] = [];

  const sendStreamStateEvent = (event: StreamStateMachineEvent) => {
    events.push(event);
    streamPhase = applyStreamStateEvent(streamPhase, event);
  };

  const chunk: ResponseChunk = {
    type: "tool-call-start",
    toolCallId: "call-1",
    toolName: "read_file",
  };

  await handleResponseChunk({
    chunk,
    state: createAssistantStreamState(),
    startThinkingIndicator: () => {},
    activeThinking: false,
    stopThinkingIndicator: () => {},
    updateSidebar: () => {},
    sendStreamStateEvent,
    appendAssistantContent: async () => {},
    appendSystemMessage: async () => "system-1",
    summarizeToolResult: () => null,
    refreshUpmergeState: async () => {},
  });

  expect(events).toContain("receive-reasoning");
  expect(streamPhase as StreamPhase).toBe("reasoning");
});

test("stream phase leaves connecting on tool input deltas", async () => {
  let streamPhase: StreamPhase = "connecting";

  await handleResponseChunk({
    chunk: {
      type: "tool-call-delta",
      toolCallId: "call-1",
      toolName: "read_file",
      argumentsDelta: '{"path":"README.md"}',
    },
    state: createAssistantStreamState(),
    startThinkingIndicator: () => {},
    activeThinking: false,
    stopThinkingIndicator: () => {},
    updateSidebar: () => {},
    sendStreamStateEvent: (event) => {
      streamPhase = applyStreamStateEvent(streamPhase, event);
    },
    appendAssistantContent: async () => {},
    appendSystemMessage: async () => "system-1",
    summarizeToolResult: () => null,
    refreshUpmergeState: async () => {},
  });

  expect(streamPhase as StreamPhase).toBe("reasoning");
});

test("stream phase stays responding when reasoning arrives after content", () => {
  let streamPhase: StreamPhase = "connecting";

  streamPhase = applyStreamStateEvent(streamPhase, "connection-established");
  streamPhase = applyStreamStateEvent(streamPhase, "receive-content");
  streamPhase = applyStreamStateEvent(streamPhase, "receive-reasoning");

  expect(streamPhase as StreamPhase).toBe("responding");
});

test("stream phase stays responding when connection-established repeats after content", () => {
  let streamPhase: StreamPhase = "connecting";

  streamPhase = applyStreamStateEvent(streamPhase, "receive-content");
  streamPhase = applyStreamStateEvent(streamPhase, "connection-established");

  expect(streamPhase as StreamPhase).toBe("responding");
});

test("approval resolution restores reasoning before any content", () => {
  let streamPhase: StreamPhase = "connecting";

  streamPhase = applyStreamStateEvent(streamPhase, "await-approval");
  streamPhase = applyStreamStateEvent(streamPhase, "approval-resolved");

  expect(streamPhase as StreamPhase).toBe("reasoning");
});

test("upmerge conflict previews stay on the text renderer path", async () => {
  const source = await fs.readFile(path.join(process.cwd(), "agent.ts"), "utf8");
  expect(source).toContain('!preview.startsWith("Text upmerge conflict: ")');
  expect(source).toContain('!preview.startsWith("Text worktree merge conflict: ")');
  expect(source).toContain('!preview.startsWith("Binary upmerge conflict: ")');
  expect(source).toContain('!preview.startsWith("Binary worktree merge conflict: ")');
});

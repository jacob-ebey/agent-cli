import { TextRenderable } from "@opentui/core";

import type { ChatEntry } from "./types.ts";
import type {
  PersistedTranscriptEntry,
  ShellExecutionResult,
  ShellMessageState,
  ShellVisibility,
} from "./types.ts";

export function formatShellMessage({
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
}: ShellMessageState) {
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

export function createInitialShellExecutionResult(): ShellExecutionResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: null,
    signal: null,
    startupError: null,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

export function createShellMessageState(
  command: string,
  visibility: ShellVisibility,
  result: ShellExecutionResult,
  running: boolean,
  cwdLabel = "."
): ShellMessageState {
  return {
    command,
    cwdLabel,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    signal: result.signal,
    startupError: result.startupError,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    running,
    visibility,
  };
}

export function createShellTranscriptEntry({
  command,
  visibility,
  transcriptHistory,
  appendEntry,
  requestRender,
  scrollToBottom,
}: {
  command: string;
  visibility: ShellVisibility;
  transcriptHistory: PersistedTranscriptEntry[];
  appendEntry: (role: "system", content: string, options: { recordInTranscript: false }) => ChatEntry;
  requestRender: () => void;
  scrollToBottom: () => void;
}) {
  let shellResult = createInitialShellExecutionResult();
  const initialState = createShellMessageState(command, visibility, shellResult, true);
  const transcriptIndex =
    transcriptHistory.push({
      role: "system",
      content: formatShellMessage(initialState),
    }) - 1;

  const entry = appendEntry("system", formatShellMessage(initialState), {
    recordInTranscript: false,
  });
  if (entry.renderKind !== "text") {
    throw new Error("Shell transcript entry body must be text renderable.");
  }
  const textBody = entry.body as TextRenderable;

  return {
    update(result: ShellExecutionResult, running: boolean) {
      shellResult = result;
      const content = formatShellMessage(
        createShellMessageState(command, visibility, shellResult, running)
      );
      textBody.content = content || " ";
      transcriptHistory[transcriptIndex] = {
        role: "system",
        content,
      };
      requestRender();
      scrollToBottom();
    },
    snapshot(running: boolean) {
      return formatShellMessage(
        createShellMessageState(command, visibility, shellResult, running)
      );
    },
  };
}

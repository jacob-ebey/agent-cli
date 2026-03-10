import { spawn } from "node:child_process";

import {
  assertInteger,
  getWorkspaceRoot,
  relativeWorkspacePath,
  resolveWorkspacePath,
  type ToolHandler,
} from "./runtime.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 64_000;

function appendChunkWithLimit(current: string, chunk: string) {
  if (current.length >= MAX_OUTPUT_CHARS) {
    return {
      value: current,
      truncated: true,
    };
  }

  const remaining = MAX_OUTPUT_CHARS - current.length;
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

async function executeShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number
) {
  const isWindows = process.platform === "win32";
  const shell = isWindows
    ? process.env.ComSpec || "cmd.exe"
    : process.env.SHELL || "/bin/sh";
  const shellArgs = isWindows
    ? ["/d", "/s", "/c", command]
    : ["-lc", command];

  return await new Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  }>((resolve, reject) => {
    const child = spawn(shell, shellArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        child.kill("SIGKILL");
      }, 5_000).unref();
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      const next = appendChunkWithLimit(stdout, chunk);
      stdout = next.value;
      stdoutTruncated ||= next.truncated;
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const next = appendChunkWithLimit(stderr, chunk);
      stderr = next.value;
      stderrTruncated ||= next.truncated;
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? (timedOut ? 124 : 0),
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

export const execute: ToolHandler = async (argumentsObject) => {
  const command = argumentsObject.command;
  if (typeof command !== "string" || !command.trim()) {
    throw new Error("command must be a non-empty string.");
  }

  const requestedCwd = argumentsObject.cwd;
  if (requestedCwd !== undefined && typeof requestedCwd !== "string") {
    throw new Error("cwd must be a string when provided.");
  }

  const timeoutMs = assertInteger(
    argumentsObject.timeout_ms,
    "timeout_ms",
    DEFAULT_TIMEOUT_MS
  );
  const resolvedCwd = requestedCwd
    ? resolveWorkspacePath(requestedCwd)
    : getWorkspaceRoot();
  const cwdLabel = relativeWorkspacePath(resolvedCwd);
  const result = await executeShellCommand(command.trim(), resolvedCwd, timeoutMs);

  return [
    `Command: ${command.trim()}`,
    `Cwd: ${cwdLabel}`,
    `Timeout ms: ${timeoutMs}`,
    `Timed out: ${result.timedOut ? "yes" : "no"}`,
    `Exit code: ${result.exitCode}`,
    "",
    "Stdout:",
    result.stdout.length ? result.stdout : "(empty)",
    result.stdoutTruncated ? "\n[stdout truncated]\n" : "",
    "",
    "Stderr:",
    result.stderr.length ? result.stderr : "(empty)",
    result.stderrTruncated ? "\n[stderr truncated]\n" : "",
  ].join("\n");
};

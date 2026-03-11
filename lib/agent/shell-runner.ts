import { spawn, type ChildProcess } from "node:child_process";

import { WORKSPACE_ROOT } from "./constants.ts";
import type { ShellExecutionResult } from "./types.ts";
import { appendChunkWithLimit } from "./utils.ts";

export async function runShellCommandSession(options: {
  command: string;
  onUpdate: (state: {
    stdout: string;
    stderr: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    result: ShellExecutionResult;
    running: boolean;
  }) => void;
  onProcessStart?: (child: ChildProcess) => void;
  onProcessEnd?: () => void;
}): Promise<ShellExecutionResult> {
  const shell =
    process.platform === "win32"
      ? process.env.ComSpec || "cmd.exe"
      : process.env.SHELL || "/bin/sh";
  const shellArgs =
    process.platform === "win32"
      ? ["/d", "/s", "/c", options.command]
      : ["-lc", options.command];
  const cwd = WORKSPACE_ROOT;

  let stdout = "";
  let stderr = "";
  let stdoutTruncated = false;
  let stderrTruncated = false;

  const initialResult: ShellExecutionResult = {
    stdout: "",
    stderr: "",
    exitCode: null,
    signal: null,
    startupError: null,
    stdoutTruncated: false,
    stderrTruncated: false,
  };

  return await new Promise<ShellExecutionResult>((resolve) => {
    let child: ChildProcess;

    try {
      child = spawn(shell, shellArgs, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
    } catch (error) {
      resolve({
        stdout,
        stderr,
        exitCode: null,
        signal: null,
        startupError: error instanceof Error ? error.message : String(error),
        stdoutTruncated,
        stderrTruncated,
      });
      return;
    }

    options.onProcessStart?.(child);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      const next = appendChunkWithLimit(stdout, chunk);
      stdout = next.value;
      stdoutTruncated ||= next.truncated;
      options.onUpdate({
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        result: {
          ...initialResult,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
        },
        running: true,
      });
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const next = appendChunkWithLimit(stderr, chunk);
      stderr = next.value;
      stderrTruncated ||= next.truncated;
      options.onUpdate({
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        result: {
          ...initialResult,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
        },
        running: true,
      });
    });

    child.on("error", (error) => {
      options.onProcessEnd?.();
      resolve({
        stdout,
        stderr,
        exitCode: null,
        signal: null,
        startupError: error instanceof Error ? error.message : String(error),
        stdoutTruncated,
        stderrTruncated,
      });
    });

    child.on("close", (exitCode, signal) => {
      options.onProcessEnd?.();
      resolve({
        stdout,
        stderr,
        exitCode,
        signal,
        startupError: null,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

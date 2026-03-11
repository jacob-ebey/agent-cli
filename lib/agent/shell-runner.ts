import { spawn, type ChildProcess } from "node:child_process";

import type { ActiveShellSession, ShellExecutionResult } from "./types.ts";
import { appendChunkWithLimit } from "./utils.ts";

function abortChildProcessTree(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.unref();
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore secondary abort errors.
      }
    }
    return;
  }

  const processGroupId = child.pid ? -child.pid : null;
  if (processGroupId !== null) {
    try {
      process.kill(processGroupId, "SIGINT");
    } catch {
      try {
        child.kill("SIGINT");
      } catch {
        // Ignore secondary abort errors.
      }
    }

    setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      try {
        process.kill(processGroupId, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          // Ignore secondary abort errors.
        }
      }
    }, 250).unref();

    setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      try {
        process.kill(processGroupId, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore secondary abort errors.
        }
      }
    }, 1_500).unref();
    return;
  }

  try {
    child.kill("SIGINT");
  } catch {
    // Ignore secondary abort errors.
  }
}

export async function runShellCommandSession(options: {
  command: string;
  cwd?: string;
  onUpdate: (state: {
    stdout: string;
    stderr: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    result: ShellExecutionResult;
    running: boolean;
  }) => void;
  onProcessStart?: (session: ActiveShellSession) => void;
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
  const cwd = options.cwd ?? process.cwd();

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
        detached: process.platform !== "win32",
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

    options.onProcessStart?.({
      process: child,
      abort: () => abortChildProcessTree(child),
    });

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

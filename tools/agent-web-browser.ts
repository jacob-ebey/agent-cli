import { spawn } from "node:child_process";
import * as path from "node:path";

import { assertInteger, prepareWorkspaceForEdit, type ToolHandler } from "./runtime.ts";

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

function getPlaywrightBrowserCachePath() {
  return path.resolve(import.meta.dir, "..", "node_modules", "playwright", ".local-browsers");
}

async function installPlaywrightBrowsers(cwd: string, timeoutMs: number) {
  const installResult = await executeAgentBrowserCommand(["install"], cwd, timeoutMs);

  if (installResult.exitCode !== 0) {
    const stderr = installResult.stderr.trim();
    const stdout = installResult.stdout.trim();
    const details = stderr || stdout || "agent-browser install exited unsuccessfully.";
    throw new Error(
      `Failed to install Playwright browser binaries automatically via \`agent-browser install\`. ${details}`
    );
  }

  const playwrightBrowsers = Bun.file(getPlaywrightBrowserCachePath());
  if (!(await playwrightBrowsers.exists())) {
    throw new Error(
      "agent-browser install completed without creating Playwright browser binaries in the expected local cache."
    );
  }
}

async function ensureAgentBrowserEnvironment(cwd: string, timeoutMs: number) {
  const playwrightBrowsers = Bun.file(getPlaywrightBrowserCachePath());
  if (await playwrightBrowsers.exists()) {
    return;
  }

  await installPlaywrightBrowsers(cwd, timeoutMs);
}

async function executeAgentBrowserWithInstallRetry(
  args: string[],
  cwd: string,
  timeoutMs: number
) {
  let firstResult;
  try {
    firstResult = await executeAgentBrowserCommand(args, cwd, timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to run agent-browser via \`npx --yes agent-browser\`. ${message}`);
  }

  const combinedOutput = `${firstResult.stderr}\n${firstResult.stdout}`;
  const missingBrowserBinaries =
    firstResult.exitCode !== 0 &&
    /browser(?:\s+binary|\s+binaries)?(?:.*)install|playwright(?:.*)install|executable doesn't exist|please run(?:.*)install/i.test(
      combinedOutput
    );

  if (!missingBrowserBinaries) {
    return firstResult;
  }

  await installPlaywrightBrowsers(cwd, timeoutMs);

  try {
    return await executeAgentBrowserCommand(args, cwd, timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to run agent-browser via \`npx --yes agent-browser\` after install retry. ${message}`);
  }
}

async function executeAgentBrowserCommand(
  args: string[],
  cwd: string,
  timeoutMs: number
) {
  const commandArgs = ["--yes", "agent-browser", ...args];

  return await new Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  }>((resolve, reject) => {
    const child = spawn("npx", commandArgs, {
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
  const url = argumentsObject.url;
  if (typeof url !== "string" || !url.length) {
    throw new Error("url must be a non-empty string.");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("url must be a valid absolute URL.");
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("url must use http or https.");
  }

  const timeoutMs = assertInteger(
    argumentsObject.timeout_ms,
    "timeout_ms",
    DEFAULT_TIMEOUT_MS
  );

  await prepareWorkspaceForEdit();

  const openResult = await executeAgentBrowserWithInstallRetry(["open", parsedUrl.toString()], process.cwd(), timeoutMs);

  if (openResult.exitCode !== 0) {
    return [
      `URL: ${parsedUrl.toString()}`,
      `Timeout ms: ${timeoutMs}`,
      `Open timed out: ${openResult.timedOut ? "yes" : "no"}`,
      `Open exit code: ${openResult.exitCode}`,
      "",
      "Open stdout:",
      openResult.stdout.length ? openResult.stdout : "(empty)",
      openResult.stdoutTruncated ? "\n[stdout truncated]\n" : "",
      "",
      "Open stderr:",
      openResult.stderr.length ? openResult.stderr : "(empty)",
      openResult.stderrTruncated ? "\n[stderr truncated]\n" : "",
    ].join("\n");
  }

  const snapshotResult = await executeAgentBrowserWithInstallRetry(["snapshot"], process.cwd(), timeoutMs);

  if (snapshotResult.exitCode === 0 && snapshotResult.stdout.trim().length) {
    return snapshotResult.stdout;
  }

  return [
    `URL: ${parsedUrl.toString()}`,
    `Timeout ms: ${timeoutMs}`,
    `Snapshot timed out: ${snapshotResult.timedOut ? "yes" : "no"}`,
    `Snapshot exit code: ${snapshotResult.exitCode}`,
    "",
    "Snapshot stdout:",
    snapshotResult.stdout.length ? snapshotResult.stdout : "(empty)",
    snapshotResult.stdoutTruncated ? "\n[stdout truncated]\n" : "",
    "",
    "Snapshot stderr:",
    snapshotResult.stderr.length ? snapshotResult.stderr : "(empty)",
    snapshotResult.stderrTruncated ? "\n[stderr truncated]\n" : "",
  ].join("\n");
};

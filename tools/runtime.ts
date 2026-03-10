import { spawn } from "node:child_process";
import * as path from "node:path";

import {
  getActiveWorkspaceRoot,
  getOriginalWorkspaceRoot,
} from "../worktree.ts";

export const WORKSPACE_ROOT = getOriginalWorkspaceRoot();

export function getWorkspaceRoot() {
  return getActiveWorkspaceRoot();
}

export type ToolHandler = (argumentsObject: Record<string, unknown>) => Promise<string>;

export function isWorkspacePath(targetPath: string) {
  const relative = path.relative(getWorkspaceRoot(), targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveWorkspacePath(targetPath: string) {
  if (!targetPath) {
    throw new Error("A path is required.");
  }

  const resolved = path.resolve(getWorkspaceRoot(), targetPath);
  if (!isWorkspacePath(resolved)) {
    throw new Error("Paths must stay within the workspace.");
  }

  return resolved;
}

export function relativeWorkspacePath(targetPath: string) {
  const relative = path.relative(getWorkspaceRoot(), targetPath);
  return relative || ".";
}

export function assertInteger(value: unknown, name: string, fallback: number) {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
}

export async function spawnCommand(command: string, args: string[], cwd: string) {
  return await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });

      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.on("error", (error) => {
        reject(error);
      });

      child.on("close", (code) => {
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 0,
        });
      });
    }
  );
}

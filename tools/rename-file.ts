import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  relativeWorkspacePath,
  resolveWorkspacePath,
  type ToolHandler,
} from "./runtime.ts";
import {
  prepareWorkspaceForEdit,
  relativeOriginalWorkspacePath,
  resolveOriginalWorkspacePath,
  trackEditTarget,
} from "../worktree.ts";

async function statIfExists(targetPath: string) {
  try {
    return await fs.stat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export const execute: ToolHandler = async (argumentsObject) => {
  const from = argumentsObject.from;
  if (typeof from !== "string" || !from.trim()) {
    throw new Error("from must be a non-empty string.");
  }

  const to = argumentsObject.to;
  if (typeof to !== "string" || !to.trim()) {
    throw new Error("to must be a non-empty string.");
  }

  const session = await prepareWorkspaceForEdit();
  const resolvedFromPath = resolveWorkspacePath(from);
  const resolvedToPath = resolveWorkspacePath(to);
  const originalFromPath = resolveOriginalWorkspacePath(from);
  const originalToPath = resolveOriginalWorkspacePath(to);

  if (resolvedFromPath === resolvedToPath) {
    throw new Error("from and to must be different paths.");
  }

  const sourceStat = await statIfExists(resolvedFromPath);
  if (sourceStat === null) {
    throw new Error(`Source path does not exist: ${relativeWorkspacePath(resolvedFromPath)}.`);
  }

  const destinationStat = await statIfExists(resolvedToPath);
  if (destinationStat !== null) {
    throw new Error(
      `Destination path already exists: ${relativeWorkspacePath(resolvedToPath)}.`
    );
  }

  const portableFrom = relativeWorkspacePath(resolvedFromPath).split(path.sep).join("/");
  const portableTo = relativeWorkspacePath(resolvedToPath).split(path.sep).join("/");
  if (portableTo.startsWith(`${portableFrom}/`)) {
    throw new Error("Cannot rename a path into one of its own descendants.");
  }

  await fs.mkdir(path.dirname(resolvedToPath), { recursive: true });

  if (session.mode === "worktree") {
    await trackEditTarget(from);
    await trackEditTarget(to);
  }

  await fs.rename(resolvedFromPath, resolvedToPath);

  if (session.mode !== "worktree") {
    return [
      `Renamed ${relativeWorkspacePath(resolvedFromPath)}.`,
      `New path: ${relativeWorkspacePath(resolvedToPath)}`,
    ].join("\n");
  }

  return [
    `Renamed ${relativeOriginalWorkspacePath(originalFromPath)} in the agent worktree.`,
    `New path: ${relativeOriginalWorkspacePath(originalToPath)}`,
    "Press `u` in the UI to review and upmerge it back into the main workspace.",
  ].join("\n");
};

import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  relativeWorkspacePath,
  resolveWorkspacePath,
  type ToolHandler,
} from "./runtime.ts";
import {
  getUpmergePreview,
  prepareWorkspaceForEdit,
  relativeOriginalWorkspacePath,
  resolveOriginalWorkspacePath,
  trackEditTarget,
} from "../worktree.ts";

function countOccurrences(source: string, search: string) {
  if (!search.length) {
    return 0;
  }

  let count = 0;
  let index = 0;

  while (true) {
    const nextIndex = source.indexOf(search, index);
    if (nextIndex === -1) {
      return count;
    }

    count += 1;
    index = nextIndex + search.length;
  }
}

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

function truncateDiffForDisplay(diff: string, maxLines = 200) {
  const lines = diff.split("\n");
  if (lines.length <= maxLines) {
    return diff;
  }

  return [
    ...lines.slice(0, maxLines),
    `... (${lines.length - maxLines} more lines omitted)`,
  ].join("\n");
}

export const execute: ToolHandler = async (argumentsObject) => {
  const requestedPath = argumentsObject.path;
  if (typeof requestedPath !== "string" || !requestedPath.trim()) {
    throw new Error("path must be a non-empty string.");
  }

  const rawOldString = argumentsObject.old_string;
  let oldString = "";
  if (rawOldString === undefined || rawOldString === null) {
    oldString = "";
  } else if (typeof rawOldString === "string") {
    oldString = rawOldString;
  } else {
    throw new Error("old_string must be a string, null, or omitted.");
  }

  const newString = argumentsObject.new_string;
  if (typeof newString !== "string") {
    throw new Error("new_string must be a string.");
  }

  const replaceAll = argumentsObject.replace_all;
  if (replaceAll !== undefined && typeof replaceAll !== "boolean") {
    throw new Error("replace_all must be a boolean when provided.");
  }

  const createIfMissing = argumentsObject.create_if_missing;
  if (createIfMissing !== undefined && typeof createIfMissing !== "boolean") {
    throw new Error("create_if_missing must be a boolean when provided.");
  }

  const session = await prepareWorkspaceForEdit();
  const trackedEdit = await trackEditTarget(requestedPath);
  const resolvedPath = resolveWorkspacePath(requestedPath);
  const originalPath = resolveOriginalWorkspacePath(requestedPath);
  const originalRelativePath = relativeOriginalWorkspacePath(originalPath);
  const stat = await statIfExists(resolvedPath);
  const shouldReplaceAll = replaceAll === true;

  if (stat === null) {
    if (createIfMissing !== true) {
      throw new Error(
        `Path does not exist: ${relativeWorkspacePath(resolvedPath)}. Set create_if_missing to true to create it.`
      );
    }

    if (oldString.length > 0) {
      throw new Error("old_string must be empty when creating a new file.");
    }

    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, newString, "utf-8");
    if (session.mode !== "worktree") {
      return `Created ${relativeWorkspacePath(resolvedPath)}.`;
    }

    const diff = truncateDiffForDisplay(await getUpmergePreview(trackedEdit.relativePath));
    return [
      `Created ${originalRelativePath} in the agent worktree.`,
      "Press `u` in the UI to review and upmerge it back into the main workspace.",
      "",
      diff,
    ].join("\n");
  }

  if (!stat.isFile()) {
    throw new Error(`path must point to a file: ${relativeWorkspacePath(resolvedPath)}`);
  }

  const raw = await fs.readFile(resolvedPath, "utf-8");

  if (!oldString.length) {
    if (raw.length > 0) {
      throw new Error(
        "old_string must be non-empty when editing a non-empty existing file."
      );
    }

    await fs.writeFile(resolvedPath, newString, "utf-8");

    if (session.mode !== "worktree") {
      return `Updated ${relativeWorkspacePath(resolvedPath)}.`;
    }

    const diff = truncateDiffForDisplay(await getUpmergePreview(trackedEdit.relativePath));
    return [
      `Updated ${originalRelativePath} in the agent worktree.`,
      "Press `u` in the UI to review and upmerge it back into the main workspace.",
      "",
      diff,
    ].join("\n");
  }

  const matchCount = countOccurrences(raw, oldString);

  if (matchCount === 0) {
    throw new Error("old_string was not found in the target file.");
  }

  if (!shouldReplaceAll && matchCount > 1) {
    throw new Error(
      `old_string matched ${matchCount} times in ${relativeWorkspacePath(resolvedPath)}. Add more context or set replace_all to true.`
    );
  }

  const updated = shouldReplaceAll
    ? raw.split(oldString).join(newString)
    : raw.replace(oldString, newString);

  if (updated === raw) {
    return `No changes made to ${relativeWorkspacePath(resolvedPath)}.`;
  }

  await fs.writeFile(resolvedPath, updated, "utf-8");

  if (session.mode !== "worktree") {
    return [
      `Updated ${relativeWorkspacePath(resolvedPath)}.`,
      `Replacements: ${shouldReplaceAll ? matchCount : 1}`,
    ].join("\n");
  }

  const diff = truncateDiffForDisplay(await getUpmergePreview(trackedEdit.relativePath));
  return [
    `Updated ${originalRelativePath} in the agent worktree.`,
    `Replacements: ${shouldReplaceAll ? matchCount : 1}`,
    "Press `u` in the UI to review and upmerge it back into the main workspace.",
    "",
    diff,
  ].join("\n");
};

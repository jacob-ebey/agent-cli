import * as fs from "node:fs/promises";

import {
  assertInteger,
  relativeWorkspacePath,
  resolveWorkspacePath,
  type ToolHandler,
} from "./runtime.ts";

export const execute: ToolHandler = async (argumentsObject) => {
  const requestedPath = argumentsObject.path;
  if (typeof requestedPath !== "string") {
    throw new Error("path must be a string.");
  }

  const offset = assertInteger(argumentsObject.offset, "offset", 1);
  const limit = assertInteger(argumentsObject.limit, "limit", 200);
  const resolvedPath = resolveWorkspacePath(requestedPath);
  const stat = await fs.stat(resolvedPath);

  if (!stat.isFile()) {
    throw new Error("path must point to a file.");
  }

  const raw = await fs.readFile(resolvedPath, "utf-8");
  if (!raw.length) {
    return `Path: ${relativeWorkspacePath(resolvedPath)}\n\nFile is empty.`;
  }

  const lines = raw.split(/\r?\n/);
  if (offset > lines.length) {
    return [
      `Path: ${relativeWorkspacePath(resolvedPath)}`,
      `Total lines: ${lines.length}`,
      "",
      "Requested slice starts beyond the end of the file.",
    ].join("\n");
  }

  const start = offset - 1;
  const end = Math.min(start + limit, lines.length);
  const numberedLines = lines
    .slice(start, end)
    .map((line, index) => `${start + index + 1}|${line}`)
    .join("\n");

  return [
    `Path: ${relativeWorkspacePath(resolvedPath)}`,
    `Lines: ${start + 1}-${end}`,
    "",
    numberedLines,
  ].join("\n");
};

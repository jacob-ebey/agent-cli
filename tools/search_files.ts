import {
  assertInteger,
  getWorkspaceRoot,
  relativeWorkspacePath,
  resolveWorkspacePath,
  spawnCommand,
  type ToolHandler,
} from "./runtime.ts";

export const execute: ToolHandler = async (argumentsObject) => {
  const pattern = argumentsObject.pattern;
  if (typeof pattern !== "string" || !pattern.trim()) {
    throw new Error("pattern must be a non-empty string.");
  }

  const requestedPath = argumentsObject.path;
  if (requestedPath !== undefined && typeof requestedPath !== "string") {
    throw new Error("path must be a string when provided.");
  }

  const glob = argumentsObject.glob;
  if (glob !== undefined && typeof glob !== "string") {
    throw new Error("glob must be a string when provided.");
  }

  const maxResults = assertInteger(argumentsObject.max_results, "max_results", 50);
  const resolvedPath = resolveWorkspacePath(requestedPath ?? ".");
  const rgArgs = ["--line-number", "--no-heading", "--color", "never"];

  if (glob) {
    rgArgs.push("--glob", glob);
  }

  rgArgs.push("--", pattern, relativeWorkspacePath(resolvedPath));

  const result = await spawnCommand("rg", rgArgs, getWorkspaceRoot());
  if (result.exitCode === 1) {
    return [
      `Pattern: ${pattern}`,
      `Path: ${relativeWorkspacePath(resolvedPath)}`,
      glob ? `Glob: ${glob}` : null,
      "",
      "No matches found.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `rg exited with code ${result.exitCode}.`);
  }

  const matches = result.stdout.trimEnd() ? result.stdout.trimEnd().split("\n") : [];
  const limitedMatches = matches.slice(0, maxResults);

  return [
    `Pattern: ${pattern}`,
    `Path: ${relativeWorkspacePath(resolvedPath)}`,
    glob ? `Glob: ${glob}` : null,
    limitedMatches.length > 0 ? `Matches: ${limitedMatches.length}` : "Matches: 0",
    matches.length > maxResults ? `Truncated: showing first ${maxResults}` : null,
    "",
    limitedMatches.join("\n") || "No matches found.",
  ]
    .filter(Boolean)
    .join("\n");
};

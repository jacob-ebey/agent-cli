import {
  assertInteger,
  getWorkspaceRoot,
  relativeWorkspacePath,
  resolveWorkspacePath,
  spawnCommand,
  type ToolHandler,
} from "./runtime.ts";

type AstGrepMatch = {
  text?: unknown;
  file?: unknown;
  lines?: unknown;
  language?: unknown;
  range?: {
    start?: {
      line?: unknown;
      column?: unknown;
    };
    end?: {
      line?: unknown;
      column?: unknown;
    };
  };
};

function isAstGrepMatch(value: unknown): value is AstGrepMatch {
  return typeof value === "object" && value !== null;
}

function formatMatch(match: AstGrepMatch) {
  const file = typeof match.file === "string" ? match.file : "(unknown file)";
  const startLine =
    typeof match.range?.start?.line === "number" ? match.range.start.line + 1 : null;
  const startColumn =
    typeof match.range?.start?.column === "number" ? match.range.start.column + 1 : null;
  const endLine = typeof match.range?.end?.line === "number" ? match.range.end.line + 1 : null;
  const endColumn =
    typeof match.range?.end?.column === "number" ? match.range.end.column + 1 : null;
  const location =
    startLine !== null && startColumn !== null
      ? `${file}:${startLine}:${startColumn}`
      : file;
  const endLocation =
    endLine !== null && endColumn !== null ? `${endLine}:${endColumn}` : null;
  const language = typeof match.language === "string" ? match.language : null;
  const matchedText = typeof match.text === "string" ? match.text : "";
  const contextLine = typeof match.lines === "string" ? match.lines.trim() : "";

  return [
    location,
    endLocation ? `Range end: ${endLocation}` : null,
    language ? `Language: ${language}` : null,
    contextLine ? `Line: ${contextLine}` : null,
    matchedText ? `Match: ${matchedText}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export const execute: ToolHandler = async (argumentsObject) => {
  const pattern = argumentsObject.pattern;
  if (typeof pattern !== "string" || !pattern.trim()) {
    throw new Error("pattern must be a non-empty string.");
  }

  const requestedPath = argumentsObject.path;
  if (requestedPath !== undefined && typeof requestedPath !== "string") {
    throw new Error("path must be a string when provided.");
  }

  const language = argumentsObject.language;
  if (language !== undefined && typeof language !== "string") {
    throw new Error("language must be a string when provided.");
  }

  const selector = argumentsObject.selector;
  if (selector !== undefined && typeof selector !== "string") {
    throw new Error("selector must be a string when provided.");
  }

  const strictness = argumentsObject.strictness;
  if (strictness !== undefined && typeof strictness !== "string") {
    throw new Error("strictness must be a string when provided.");
  }

  const glob = argumentsObject.glob;
  if (glob !== undefined && typeof glob !== "string") {
    throw new Error("glob must be a string when provided.");
  }

  const maxResults = assertInteger(argumentsObject.max_results, "max_results", 50);
  const resolvedPath = resolveWorkspacePath(requestedPath ?? ".");
  const sgArgs = ["run", "--json=stream", "--color", "never", "--pattern", pattern.trim()];

  if (language?.trim()) {
    sgArgs.push("--lang", language.trim());
  }

  if (selector?.trim()) {
    sgArgs.push("--selector", selector.trim());
  }

  if (strictness?.trim()) {
    sgArgs.push("--strictness", strictness.trim());
  }

  if (glob?.trim()) {
    sgArgs.push("--globs", glob.trim());
  }

  sgArgs.push(relativeWorkspacePath(resolvedPath));

  const result = await spawnCommand("sg", sgArgs, getWorkspaceRoot());
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `sg exited with code ${result.exitCode}.`);
  }

  const parsedMatches = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new Error("Failed to parse ast-grep JSON output.");
      }
    })
    .filter(isAstGrepMatch);

  const limitedMatches = parsedMatches.slice(0, maxResults);

  return [
    `Pattern: ${pattern.trim()}`,
    `Path: ${relativeWorkspacePath(resolvedPath)}`,
    language?.trim() ? `Language: ${language.trim()}` : null,
    selector?.trim() ? `Selector: ${selector.trim()}` : null,
    strictness?.trim() ? `Strictness: ${strictness.trim()}` : null,
    glob?.trim() ? `Glob: ${glob.trim()}` : null,
    `Matches: ${parsedMatches.length}`,
    parsedMatches.length > maxResults ? `Truncated: showing first ${maxResults}` : null,
    "",
    limitedMatches.length
      ? limitedMatches.map((match) => formatMatch(match)).join("\n\n")
      : "No matches found.",
  ]
    .filter(Boolean)
    .join("\n");
};

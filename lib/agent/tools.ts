import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import {
  AGENTS_MD_INITIAL_TOOL_SEEDS,
  INITIAL_TOOL_SEEDS,
  TOOLS_DIRECTORY,
} from "./constants.ts";
import type {
  ConversationMessage,
  InitialToolMessageSeed,
  LoadedTool,
  ToolDefinition,
  ToolExecutor,
  ToolMetadata,
} from "./types.ts";
import {
  isRecord,
  matchOutputLabel,
  normalizeWhitespace,
  readIntegerArgument,
  readStringArgument,
} from "./utils.ts";

export function parseToolDefinition(source: string): ToolDefinition | null {
  const nameMatch = source.match(/^#\s*`?([a-zA-Z0-9_-]+)`?\s*$/m);
  const descriptionMatch = source.match(
    /##\s*Description\s*\n+([\s\S]*?)(?=\n##\s|\s*$)/
  );
  const parametersMatch = source.match(
    /##\s*Parameters\s*\n+```json\s*\n([\s\S]*?)\n```/
  );

  if (!nameMatch || !descriptionMatch || !parametersMatch) {
    return null;
  }

  return {
    name: nameMatch[1],
    description: normalizeWhitespace(descriptionMatch[1]),
    inputSchema: JSON.parse(parametersMatch[1]),
  };
}

export function parseToolMetadata(source: string): ToolMetadata {
  const metadataMatch = source.match(
    /##\s*Metadata\s*\n+```json\s*\n([\s\S]*?)\n```/
  );
  if (!metadataMatch) {
    return {
      requiresApproval: false,
      approvalScope: "path",
      approvalPersistence: "session",
    };
  }

  const parsed = JSON.parse(metadataMatch[1]) as {
    requiresApproval?: unknown;
    approvalScope?: unknown;
    approvalPersistence?: unknown;
  };

  return {
    requiresApproval: parsed.requiresApproval === true,
    approvalScope: parsed.approvalScope === "command" ? "command" : "path",
    approvalPersistence:
      parsed.approvalPersistence === "persisted" ? "persisted" : "session",
  };
}

export async function loadTools() {
  const files = await fs.readdir(TOOLS_DIRECTORY);
  const loadedTools = await Promise.all(
    files
      .filter((file) => file.endsWith(".md") && file !== "system-prompt.md")
      .map(async (file) => {
        const source = await fs.readFile(
          path.join(TOOLS_DIRECTORY, file),
          "utf-8"
        );
        const parsedDefinition = parseToolDefinition(source);
        const metadata = parseToolMetadata(source);
        if (!parsedDefinition) {
          return null;
        }

        const expectedName = path.basename(file, ".md");
        if (parsedDefinition.name !== expectedName) {
          throw new Error(
            `Tool definition name "${parsedDefinition.name}" must match "${expectedName}.md".`
          );
        }

        const modulePath = path.join(TOOLS_DIRECTORY, `${expectedName}.ts`);
        const toolModule = (await import(pathToFileURL(modulePath).href)) as {
          execute?: ToolExecutor;
        };

        if (typeof toolModule.execute !== "function") {
          throw new Error(
            `Tool module "${expectedName}.ts" must export an execute function.`
          );
        }

        return [
          parsedDefinition.name,
          {
            definition: parsedDefinition,
            execute: toolModule.execute,
            metadata,
          },
        ] as const;
      })
  );

  return new Map(
    loadedTools.filter(
      (entry): entry is readonly [string, LoadedTool] => entry !== null
    )
  );
}

function createInitialToolResultOutput(output: string) {
  return {
    type: "text" as const,
    value: output,
  };
}

async function loadSeededToolMessages(options: {
  loadedTools: Map<string, LoadedTool>;
  seeds: InitialToolMessageSeed[];
}) {
  const seededResults = await Promise.all(
    options.seeds.map(async (seed) => {
      const tool = options.loadedTools.get(seed.toolName);
      if (!tool) {
        return null;
      }

      try {
        const output = await tool.execute(seed.input);
        return {
          ...seed,
          output,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ...seed,
          output: `Initial tool call failed.\n\n${message}`,
        };
      }
    })
  );
  const completedSeeds = seededResults.filter(
    (
      seed
    ): seed is InitialToolMessageSeed & {
      output: string;
    } => seed !== null
  );

  if (completedSeeds.length === 0) {
    return [];
  }

  return [
    {
      role: "assistant",
      content: completedSeeds.map((seed) => ({
        type: "tool-call" as const,
        toolCallId: seed.toolCallId,
        toolName: seed.toolName,
        input: seed.input,
      })),
    },
    {
      role: "tool",
      content: completedSeeds.map((seed) => ({
        type: "tool-result" as const,
        toolCallId: seed.toolCallId,
        toolName: seed.toolName,
        output: createInitialToolResultOutput(seed.output),
      })),
    },
  ] satisfies ConversationMessage[];
}

export async function loadInitialToolMessages(loadedTools: Map<string, LoadedTool>) {
  const seeds: InitialToolMessageSeed[] = INITIAL_TOOL_SEEDS;
  return loadSeededToolMessages({
    loadedTools,
    seeds,
  });
}

export async function loadAgentsMdInitialToolMessages(loadedTools: Map<string, LoadedTool>) {
  return loadSeededToolMessages({
    loadedTools,
    seeds: AGENTS_MD_INITIAL_TOOL_SEEDS,
  });
}

export function summarizeToolResult(
  toolName: string,
  input: unknown,
  output: unknown
) {
  const argumentsObject = isRecord(input) ? input : {};

  switch (toolName) {
    case "read-file": {
      const requestedPath = readStringArgument(argumentsObject, "path");
      const offset = readIntegerArgument(argumentsObject, "offset");
      const limit = readIntegerArgument(argumentsObject, "limit");
      const range = offset
        ? limit
          ? `Requested lines: ${offset}-${offset + limit - 1}.`
          : `Requested from line ${offset}.`
        : null;

      return [
        requestedPath
          ? `Read file \`${requestedPath}\`.`
          : "Read a workspace file.",
        range,
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "ripgrep": {
      const pattern = readStringArgument(argumentsObject, "pattern");
      const requestedPath = readStringArgument(argumentsObject, "path") ?? ".";
      const glob = readStringArgument(argumentsObject, "glob");
      const matches = matchOutputLabel(output, "Matches");
      const truncated = matchOutputLabel(output, "Truncated");

      return [
        pattern
          ? `Searched files in \`${requestedPath}\` for \`${pattern}\`.`
          : `Searched files in \`${requestedPath}\`.`,
        glob ? `Glob: \`${glob}\`.` : null,
        matches ? `${matches} result(s).` : null,
        truncated ? truncated : null,
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "search-skills": {
      const query = readStringArgument(argumentsObject, "query");
      const indexedChunks = matchOutputLabel(output, "Indexed chunks");
      const resultsCount =
        typeof output === "string"
          ? Array.from(output.matchAll(/^\d+\.\s/gm)).length
          : null;

      return [
        query
          ? `Searched indexed skills for \`${query}\`.`
          : "Searched indexed skills.",
        resultsCount !== null ? `${resultsCount} result(s).` : null,
        indexedChunks ? `Indexed chunks available: ${indexedChunks}.` : null,
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "run-shell-command": {
      const command = readStringArgument(argumentsObject, "command");
      const requestedPath = readStringArgument(argumentsObject, "cwd") ?? ".";
      const exitCode = matchOutputLabel(output, "Exit code");
      const timedOut = matchOutputLabel(output, "Timed out");

      return [
        command
          ? `Ran shell command \`${command}\` from \`${requestedPath}\`.`
          : `Ran a shell command from \`${requestedPath}\`.`,
        exitCode ? `Exit code: ${exitCode}.` : null,
        timedOut ? `Timed out: ${timedOut}.` : null,
      ]
        .filter(Boolean)
        .join("\n");
    }
    default:
      return null;
  }
}

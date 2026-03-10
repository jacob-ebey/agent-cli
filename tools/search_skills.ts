import { searchSkillsIndex } from "../lib/skills-index.ts";
import { WORKSPACE_ROOT, assertInteger, type ToolHandler } from "./runtime.ts";

export const execute: ToolHandler = async (argumentsObject) => {
  const query = argumentsObject.query;
  if (typeof query !== "string" || !query.trim()) {
    throw new Error("query must be a non-empty string.");
  }

  const maxResults = assertInteger(argumentsObject.max_results, "max_results", 5);
  const includeContent = argumentsObject.include_content === true;
  const { index, results } = await searchSkillsIndex(WORKSPACE_ROOT, query, maxResults);

  return [
    `Query: ${query.trim()}`,
    `Embedding model: ${index.embeddingModel}`,
    `Indexed chunks: ${index.chunks.length}`,
    `Generated at: ${index.generatedAt}`,
    "",
    results.length
      ? results
          .map((result, index) =>
            [
              `${index + 1}. ${result.name} :: ${result.section}`,
              `Path: ${result.path}`,
              `Lines: ${result.startLine}-${result.endLine}`,
              `Score: ${result.score.toFixed(4)}`,
              `Blurb: ${result.blurb}`,
              includeContent ? "" : null,
              includeContent ? "Chunk:" : null,
              includeContent ? result.content : null,
            ]
              .filter((line) => line !== null)
              .join("\n")
          )
          .join("\n\n")
      : "No indexed skills matched the query.",
    "",
    "Use `read_file` with the skill path when you need the full file.",
  ].join("\n");
};

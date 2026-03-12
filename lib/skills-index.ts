import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { embedValues, getPreferredEmbeddingConfiguration } from "./llm.ts";

const INDEX_VERSION = 3;
const SKILLS_DIRECTORY = path.join(".agents", "skills");
const SKILLS_INDEX_PATH = path.join(".agents", "skills-index.json");
const MAX_CHUNK_CHARS = 900;
const MIN_CHUNK_CHARS = 300;
const BLURB_LENGTH = 220;

export type IndexedSkillChunk = {
  name: string;
  path: string;
  section: string;
  startLine: number;
  endLine: number;
  blurb: string;
  content: string;
  embedding: number[];
};

export type SkillsIndex = {
  version: number;
  workspaceRoot: string;
  generatedAt: string;
  embeddingModel: string;
  chunks: IndexedSkillChunk[];
};

export type SkillSearchResult = {
  name: string;
  path: string;
  section: string;
  startLine: number;
  endLine: number;
  blurb: string;
  content: string;
  score: number;
};

async function listSkillFiles(workspaceRoot: string) {
  const skillsRoot = path.join(workspaceRoot, SKILLS_DIRECTORY);

  let entries: Dirent[];
  try {
    entries = await fs.readdir(skillsRoot, {
      withFileTypes: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [] as string[];
    }

    throw error;
  }

  const skillFiles = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(skillsRoot, entry.name, "SKILL.md"))
    .sort((left, right) => left.localeCompare(right));

  const existingFiles = await Promise.all(
    skillFiles.map(async (skillFile) => {
      try {
        const stat = await fs.stat(skillFile);
        return stat.isFile() ? skillFile : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }

        throw error;
      }
    })
  );

  return existingFiles.filter((file): file is string => file !== null);
}

function cosineSimilarity(left: number[], right: number[]) {
  if (left.length !== right.length || left.length === 0) {
    return 0;
  }

  let dotProduct = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dotProduct += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function getRelativeSkillPath(workspaceRoot: string, absolutePath: string) {
  return path.relative(workspaceRoot, absolutePath) || ".";
}

function normalizeBlurb(source: string) {
  return source.replace(/^#{1,6}\s+/gm, "").replace(/\s+/g, " ").trim();
}

function buildBlurb(source: string) {
  const normalized = normalizeBlurb(source);
  if (normalized.length <= BLURB_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, BLURB_LENGTH - 1).trimEnd()}...`;
}

function splitSkillContentIntoChunks(
  name: string,
  filePath: string,
  content: string
): Array<Omit<IndexedSkillChunk, "embedding">> {
  const lines = content.split(/\r?\n/);
  const sections: Array<{
    title: string;
    startLine: number;
    endLine: number;
    content: string;
  }> = [];
  const headingStack: string[] = [];

  let currentTitle = "Overview";
  let currentStartLine = 1;
  let currentLines: string[] = [];

  const flushSection = (endLine: number) => {
    const sectionContent = currentLines.join("\n").trim();
    if (!sectionContent) {
      return;
    }

    sections.push({
      title: currentTitle,
      startLine: currentStartLine,
      endLine,
      content: sectionContent,
    });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNumber = index + 1;
    const headingMatch = line.match(/^(#{1,6})\s+(.*\S)\s*$/);

    if (headingMatch) {
      flushSection(lineNumber - 1);

      const headingLevel = headingMatch[1].length;
      const headingTitle = headingMatch[2].trim();
      headingStack.splice(headingLevel - 1);
      headingStack[headingLevel - 1] = headingTitle;

      currentTitle = headingStack.join(" > ");
      currentStartLine = lineNumber;
      currentLines = [line];
      continue;
    }

    currentLines.push(line);
  }

  flushSection(lines.length);

  return sections.flatMap((section) => {
    const sectionLines = section.content.split(/\r?\n/);
    const blocks: Array<{
      startLine: number;
      endLine: number;
      text: string;
    }> = [];

    let blockStartLine = section.startLine;
    let blockLines: string[] = [];

    const flushBlock = (lineNumber: number) => {
      const blockText = blockLines.join("\n").trim();
      if (!blockText) {
        blockLines = [];
        return;
      }

      blocks.push({
        startLine: blockStartLine,
        endLine: lineNumber,
        text: blockText,
      });
      blockLines = [];
    };

    for (let index = 0; index < sectionLines.length; index += 1) {
      const line = sectionLines[index] ?? "";
      const lineNumber = section.startLine + index;

      if (!line.trim()) {
        flushBlock(lineNumber - 1);
        blockStartLine = lineNumber + 1;
        continue;
      }

      if (!blockLines.length) {
        blockStartLine = lineNumber;
      }

      blockLines.push(line);
    }

    flushBlock(section.endLine);

    if (!blocks.length) {
      return [];
    }

    const chunks: Array<Omit<IndexedSkillChunk, "embedding">> = [];
    let chunkBlocks: typeof blocks = [];
    let chunkLength = 0;

    const flushChunk = () => {
      if (!chunkBlocks.length) {
        return;
      }

      const chunkText = chunkBlocks.map((block) => block.text).join("\n\n");
      chunks.push({
        name,
        path: filePath,
        section: section.title,
        startLine: chunkBlocks[0].startLine,
        endLine: chunkBlocks[chunkBlocks.length - 1].endLine,
        blurb: buildBlurb(chunkText),
        content: chunkText,
      });

      chunkBlocks = [];
      chunkLength = 0;
    };

    for (const block of blocks) {
      const additionalLength = block.text.length + (chunkBlocks.length ? 2 : 0);

      if (
        chunkBlocks.length &&
        chunkLength + additionalLength > MAX_CHUNK_CHARS &&
        chunkLength >= MIN_CHUNK_CHARS
      ) {
        flushChunk();
      }

      chunkBlocks.push(block);
      chunkLength += additionalLength;
    }

    flushChunk();
    return chunks;
  });
}

function isIndexedSkillChunk(value: unknown): value is IndexedSkillChunk {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as {
    name?: unknown;
    path?: unknown;
    section?: unknown;
    startLine?: unknown;
    endLine?: unknown;
    blurb?: unknown;
    content?: unknown;
    embedding?: unknown;
  };

  return (
    typeof candidate.name === "string" &&
    typeof candidate.path === "string" &&
    typeof candidate.section === "string" &&
    typeof candidate.startLine === "number" &&
    Number.isInteger(candidate.startLine) &&
    candidate.startLine > 0 &&
    typeof candidate.endLine === "number" &&
    Number.isInteger(candidate.endLine) &&
    candidate.endLine >= candidate.startLine &&
    typeof candidate.blurb === "string" &&
    typeof candidate.content === "string" &&
    Array.isArray(candidate.embedding) &&
    candidate.embedding.every((entry) => typeof entry === "number")
  );
}

export function getSkillsIndexPath(workspaceRoot: string) {
  return path.join(workspaceRoot, SKILLS_INDEX_PATH);
}

export async function loadSkillsIndex(workspaceRoot: string): Promise<SkillsIndex> {
  const indexPath = getSkillsIndexPath(workspaceRoot);
  let source: string;
  try {
    source = await fs.readFile(indexPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Skill index not found. Run `:index` to build `.agents/skills-index.json`.");
    }

    throw error;
  }
  const parsed = JSON.parse(source) as {
    version?: unknown;
    workspaceRoot?: unknown;
    generatedAt?: unknown;
    embeddingModel?: unknown;
    chunks?: unknown;
  };

  if (
    parsed.version !== INDEX_VERSION ||
    typeof parsed.workspaceRoot !== "string" ||
    typeof parsed.generatedAt !== "string" ||
    typeof parsed.embeddingModel !== "string" ||
    !Array.isArray(parsed.chunks) ||
    !parsed.chunks.every(isIndexedSkillChunk)
  ) {
    throw new Error("Skill index is invalid. Run `:index` to rebuild it.");
  }

  return {
    version: parsed.version,
    workspaceRoot: parsed.workspaceRoot,
    generatedAt: parsed.generatedAt,
    embeddingModel: parsed.embeddingModel,
    chunks: parsed.chunks,
  };
}

export async function indexSkills(workspaceRoot: string) {
  const embeddingConfiguration = getPreferredEmbeddingConfiguration();

  const skillFiles = await listSkillFiles(workspaceRoot);
  if (!skillFiles.length) {
    throw new Error("No `.agents/skills/*/SKILL.md` files were found.");
  }

  const chunkInputs = (
    await Promise.all(
    skillFiles.map(async (skillFile) => {
      const content = await fs.readFile(skillFile, "utf-8");
        return splitSkillContentIntoChunks(
          path.basename(path.dirname(skillFile)),
          getRelativeSkillPath(workspaceRoot, skillFile),
          content
        );
    })
    )
  ).flat();

  if (!chunkInputs.length) {
    throw new Error("No non-empty skill content was found to index.");
  }

  let embeddings: number[][];
  try {
    embeddings = await embedValues(
      chunkInputs.map((chunk) =>
        [`Skill: ${chunk.name}`, `Section: ${chunk.section}`, chunk.content].join("\n")
      ),
      embeddingConfiguration
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to build the skills index offline-safe fallback data because embeddings could not be generated. ${message}`
    );
  }

  const index: SkillsIndex = {
    version: INDEX_VERSION,
    workspaceRoot,
    generatedAt: new Date().toISOString(),
    embeddingModel: `${embeddingConfiguration.backend}:${embeddingConfiguration.modelId}`,
    chunks: chunkInputs.map((chunk, index) => ({
      ...chunk,
      embedding: embeddings[index] ?? [],
    })),
  };

  const indexPath = getSkillsIndexPath(workspaceRoot);
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf-8");

  return index;
}

export async function searchSkillsIndex(
  workspaceRoot: string,
  query: string,
  maxResults = 5
): Promise<{
  index: SkillsIndex;
  results: SkillSearchResult[];
}> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    throw new Error("query must be a non-empty string.");
  }

  const index = await loadSkillsIndex(workspaceRoot);
  if (!index.chunks.length) {
    return {
      index,
      results: [],
    };
  }

  let queryEmbedding: number[] | undefined;
  try {
    [queryEmbedding] = await embedValues([trimmedQuery]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Skill search is unavailable because the query embedding request failed. ${message}`
    );
  }
  const results = index.chunks
    .map((chunk) => ({
      name: chunk.name,
      path: chunk.path,
      section: chunk.section,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      blurb: chunk.blurb,
      content: chunk.content,
      score: cosineSimilarity(queryEmbedding ?? [], chunk.embedding),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, maxResults));

  return {
    index,
    results,
  };
}

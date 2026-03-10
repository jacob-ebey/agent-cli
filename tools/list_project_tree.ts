import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  assertInteger,
  relativeWorkspacePath,
  resolveWorkspacePath,
  spawnCommand,
  WORKSPACE_ROOT,
  type ToolHandler,
} from "./runtime.ts";

type FileNode = {
  type: "file";
  name: string;
};

type DirectoryNode = {
  type: "directory";
  name: string;
  children: Map<string, TreeNode>;
};

type TreeNode = FileNode | DirectoryNode;

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

async function getAgentsIgnoreArgs() {
  const agentsIgnorePath = path.join(WORKSPACE_ROOT, ".agentsignore");
  const stat = await statIfExists(agentsIgnorePath);

  if (!stat?.isFile()) {
    return {
      args: [] as string[],
      enabled: false,
    };
  }

  return {
    args: ["--ignore-file", relativeWorkspacePath(agentsIgnorePath)],
    enabled: true,
  };
}

async function listVisibleWorkspaceFiles(targetRelativePath: string, agentsIgnoreArgs: string[]) {
  const rgArgs = [
    "--files",
    "--hidden",
    "--glob",
    "!.git",
    "--glob",
    "!.git/**",
    ...agentsIgnoreArgs,
  ];

  if (targetRelativePath !== ".") {
    rgArgs.push(targetRelativePath);
  }

  const result = await spawnCommand("rg", rgArgs, WORKSPACE_ROOT);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `rg exited with code ${result.exitCode}.`);
  }

  return result.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function createDirectoryNode(name: string): DirectoryNode {
  return {
    type: "directory",
    name,
    children: new Map(),
  };
}

function insertFile(root: DirectoryNode, relativeFilePath: string) {
  const segments = relativeFilePath.split("/").filter(Boolean);
  let current = root;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const isLast = index === segments.length - 1;
    const existing = current.children.get(segment);

    if (isLast) {
      current.children.set(segment, {
        type: "file",
        name: segment,
      });
      continue;
    }

    if (existing?.type === "directory") {
      current = existing;
      continue;
    }

    const directory = createDirectoryNode(segment);
    current.children.set(segment, directory);
    current = directory;
  }
}

function sortNodes(nodes: Iterable<TreeNode>) {
  return Array.from(nodes).sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "directory" ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
}

function renderTree(root: DirectoryNode, maxDepth: number, maxEntries: number) {
  const lines = [`${root.name}/`];
  let renderedEntries = 0;
  let truncatedByEntries = false;
  let truncatedByDepth = false;

  const visit = (node: DirectoryNode, prefix: string, depth: number) => {
    const children = sortNodes(node.children.values());

    for (let index = 0; index < children.length; index += 1) {
      if (renderedEntries >= maxEntries) {
        truncatedByEntries = true;
        return;
      }

      const child = children[index];
      const isLast = index === children.length - 1;
      const connector = isLast ? "`-- " : "|-- ";
      const nextPrefix = prefix + (isLast ? "    " : "|   ");

      if (child.type === "directory") {
        lines.push(`${prefix}${connector}${child.name}/`);
        renderedEntries += 1;

        if (depth >= maxDepth) {
          if (child.children.size > 0) {
            truncatedByDepth = true;
          }
          continue;
        }

        visit(child, nextPrefix, depth + 1);
        if (truncatedByEntries) {
          return;
        }
        continue;
      }

      lines.push(`${prefix}${connector}${child.name}`);
      renderedEntries += 1;
    }
  };

  visit(root, "", 1);

  if (truncatedByEntries) {
    lines.push("...");
  }

  return {
    lines,
    truncatedByEntries,
    truncatedByDepth,
  };
}

export const execute: ToolHandler = async (argumentsObject) => {
  const requestedPath = argumentsObject.path;
  if (requestedPath !== undefined && typeof requestedPath !== "string") {
    throw new Error("path must be a string when provided.");
  }

  const maxDepth = assertInteger(argumentsObject.max_depth, "max_depth", 6);
  const maxEntries = assertInteger(argumentsObject.max_entries, "max_entries", 200);
  const resolvedPath = resolveWorkspacePath(requestedPath ?? ".");
  const stat = await fs.stat(resolvedPath);

  if (!stat.isDirectory() && !stat.isFile()) {
    throw new Error("path must point to a file or directory.");
  }

  const targetRelativePath = relativeWorkspacePath(resolvedPath);
  const { args: agentsIgnoreArgs, enabled: agentsIgnoreEnabled } = await getAgentsIgnoreArgs();
  const visibleWorkspaceFiles = await listVisibleWorkspaceFiles(
    targetRelativePath,
    agentsIgnoreArgs
  );

  if (stat.isFile()) {
    const visible = visibleWorkspaceFiles.includes(targetRelativePath);
    return [
      `Path: ${targetRelativePath}`,
      `Ignored by: ${agentsIgnoreEnabled ? ".gitignore, .agentsignore" : ".gitignore"}`,
      "",
      visible ? path.basename(targetRelativePath) : "The requested file is hidden by ignore rules.",
    ].join("\n");
  }

  const visibleRelativeFiles = visibleWorkspaceFiles.map((workspaceFilePath) =>
    targetRelativePath === "." ? workspaceFilePath : path.relative(targetRelativePath, workspaceFilePath)
  );

  if (visibleRelativeFiles.length === 0) {
    return [
      `Path: ${targetRelativePath}`,
      `Ignored by: ${agentsIgnoreEnabled ? ".gitignore, .agentsignore" : ".gitignore"}`,
      "",
      "No visible files found.",
    ].join("\n");
  }

  const rootName = targetRelativePath === "." ? "." : path.basename(resolvedPath);
  const root = createDirectoryNode(rootName);

  for (const relativeFilePath of visibleRelativeFiles) {
    insertFile(root, relativeFilePath);
  }

  const renderedTree = renderTree(root, maxDepth, maxEntries);

  return [
    `Path: ${targetRelativePath}`,
    `Visible files: ${visibleRelativeFiles.length}`,
    `Max depth: ${maxDepth}`,
    `Max entries: ${maxEntries}`,
    `Ignored by: ${agentsIgnoreEnabled ? ".gitignore, .agentsignore" : ".gitignore"}`,
    renderedTree.truncatedByEntries ? "Truncated: reached max_entries" : null,
    renderedTree.truncatedByDepth ? "Truncated: reached max_depth" : null,
    "",
    renderedTree.lines.join("\n"),
  ]
    .filter(Boolean)
    .join("\n");
};

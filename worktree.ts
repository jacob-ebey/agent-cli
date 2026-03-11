import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { generateTextResponse, type Message } from "./lib/llm.ts";

const DEV_NULL_PATH = "/dev/null";

type BaselineRecord = {
  baselinePath: string | null;
  exists: boolean;
};

type UpmergeConflictRecord = {
  type: "text" | "binary";
  status: "pending";
  phase?: "publish" | "sync-down";
};

const UPMERGE_IGNORED_PATHS = new Set([".agents/PLAN.md"]);

function shouldIgnoreUpmergePath(relativePath: string) {
  return UPMERGE_IGNORED_PATHS.has(relativePath.split(path.sep).join("/"));
}

type SessionState =
  | {
      initialized: false;
      mode: "direct";
      note: string;
      trackedFiles: Map<string, BaselineRecord>;
      conflicts: Map<string, UpmergeConflictRecord>;
    }
  | {
      initialized: true;
      mode: "direct";
      note: string;
      trackedFiles: Map<string, BaselineRecord>;
      conflicts: Map<string, UpmergeConflictRecord>;
    }
  | {
      initialized: true;
      mode: "worktree";
      note: string;
      trackedFiles: Map<string, BaselineRecord>;
      conflicts: Map<string, UpmergeConflictRecord>;
      gitRoot: string;
      sessionRoot: string;
      worktreeRoot: string;
      worktreeWorkspaceRoot: string;
      baselinesRoot: string;
    };

export type PersistedWorkspaceSession = {
  version: 1;
  mode: "worktree";
  note: string;
  trackedFiles: Array<{
    relativePath: string;
    baselinePath: string | null;
    exists: boolean;
  }>;
  conflicts: Array<{
    relativePath: string;
    type: "text" | "binary";
    status: "pending";
  }>;
  gitRoot: string;
  sessionRoot: string;
  worktreeRoot: string;
  worktreeWorkspaceRoot: string;
  baselinesRoot: string;
};

export type UpmergeConflictStatus = {
  path: string;
  type: "text" | "binary";
  status: "pending";
  phase: "publish" | "sync-down";
};

export type UpmergeStatus = {
  mode: "direct" | "worktree";
  note: string;
  pendingFiles: string[];
  conflictedFiles: UpmergeConflictStatus[];
};

export type UpmergeResolutionStrategy = "accept-main" | "accept-worktree" | "mark-resolved";

function createInitialSessionState(): SessionState {
  return {
    initialized: false,
    mode: "direct",
    note: "A git worktree will be created on the first edit when available.",
    trackedFiles: new Map(),
    conflicts: new Map(),
  };
}

export type WorkspaceSessionManager = {
  getOriginalWorkspaceRoot: () => string;
  setWorkspaceSessionStorageRoot: (storageRoot: string | null) => void;
  captureWorkspaceSession: () => PersistedWorkspaceSession | null;
  restoreWorkspaceSession: (session: PersistedWorkspaceSession | null) => void;
  getActiveWorkspaceRoot: () => string;
  getActiveWorkspaceAbsolutePath: () => string;
  resolveOriginalWorkspacePath: (targetPath: string) => string;
  relativeOriginalWorkspacePath: (targetPath: string) => string;
  prepareWorkspaceForEdit: () => Promise<SessionState>;
  trackEditTarget: (targetPath: string) => Promise<{ mode: "direct" | "worktree"; relativePath: string }>;
  mergeSourceIntoWorktree: (options?: {
    sourceRef?: string;
    remote?: string;
    branch?: string;
  }) => Promise<string>;
  autoResolveSyncDownConflict: (options: {
    relativePath: string;
    model: string;
    abortSignal?: AbortSignal;
  }) => Promise<string>;
  getUpmergeStatus: () => Promise<UpmergeStatus>;
  getUpmergePreview: (relativePath?: string) => Promise<string>;
  upmergeRelativePath: (relativePath: string) => Promise<string>;
  revertRelativePath: (relativePath: string) => Promise<string>;
  upmergeAll: () => Promise<string>;
  resolveUpmergeConflict: (
    relativePath: string,
    strategy: UpmergeResolutionStrategy
  ) => Promise<string>;
  cleanupWorkspaceSession: (targetSession?: PersistedWorkspaceSession | null) => Promise<void>;
};

export function createWorkspaceSessionManager(workspaceRoot = process.cwd()): WorkspaceSessionManager {
  const ORIGINAL_WORKSPACE_ROOT = workspaceRoot;
  const SHELL_CONFIG_PATH = path.join(ORIGINAL_WORKSPACE_ROOT, ".agents", "shell.json");

  let sessionState: SessionState = createInitialSessionState();
  let detectedGitRoot: string | null | undefined;
  let ensureSessionPromise: Promise<SessionState> | null = null;
  let sessionStorageRoot: string | null = null;

  function toPortablePath(relativePath: string) {
    return relativePath.split(path.sep).join("/");
  }

  function isInsideRoot(root: string, targetPath: string) {
  const relative = path.relative(root, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolvePathWithinRoot(root: string, targetPath: string) {
  if (!targetPath) {
    throw new Error("A path is required.");
  }

  const resolved = path.resolve(root, targetPath);
  if (!isInsideRoot(root, resolved)) {
    throw new Error("Paths must stay within the workspace.");
  }

  return resolved;
}

async function runCommand(command: string, args: string[], cwd: string, input?: string) {
  return await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
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

      child.on("error", reject);
      child.on("close", (code) => {
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 0,
        });
      });

      if (input !== undefined) {
        child.stdin?.end(input);
      } else {
        child.stdin?.end();
      }
    }
  );
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

async function readFileIfExists(targetPath: string) {
  const stat = await statIfExists(targetPath);
  if (!stat?.isFile()) {
    return null;
  }
  return await fs.readFile(targetPath);
}

async function filesEqual(leftPath: string | null, rightPath: string | null) {
  const [left, right] = await Promise.all([
    leftPath ? readFileIfExists(leftPath) : Promise.resolve(null),
    rightPath ? readFileIfExists(rightPath) : Promise.resolve(null),
  ]);

  if (left === null || right === null) {
    return left === right;
  }

  return left.equals(right);
}

function buffersEqual(left: Buffer | null, right: Buffer | null) {
  if (left === null || right === null) {
    return left === right;
  }

  return left.equals(right);
}

function isProbablyBinary(content: Buffer | null) {
  return content?.includes(0) ?? false;
}

async function detectGitRoot() {
  if (detectedGitRoot !== undefined) {
    return detectedGitRoot;
  }

  const result = await runCommand(
    "git",
    ["rev-parse", "--show-toplevel"],
    ORIGINAL_WORKSPACE_ROOT
  );
  detectedGitRoot = result.exitCode === 0 ? result.stdout.trim() : null;
  return detectedGitRoot;
}

async function syncWorkspaceChangesIntoWorktree(worktreeWorkspaceRoot: string) {
  const result = await runCommand(
    "git",
    ["ls-files", "--modified", "--others", "--deleted", "--exclude-standard", "--", "."],
    ORIGINAL_WORKSPACE_ROOT
  );

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "Failed to inspect workspace changes.");
  }

  const changedFiles = result.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const relativePath of changedFiles) {
    const sourcePath = path.join(ORIGINAL_WORKSPACE_ROOT, relativePath);
    const targetPath = path.join(worktreeWorkspaceRoot, relativePath);
    const sourceStat = await statIfExists(sourcePath);

    if (sourceStat?.isFile()) {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(sourcePath, targetPath);
      continue;
    }

    await fs.rm(targetPath, { force: true });
  }
}

async function loadStartupCommands() {
  try {
    const source = await fs.readFile(SHELL_CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(source) as {
      startupCommands?: unknown;
    };

    if (!Array.isArray(parsed.startupCommands)) {
      return [];
    }

    return parsed.startupCommands
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    console.warn(`Failed to load shell config from ${SHELL_CONFIG_PATH}:`, error);
    return [];
  }
}

async function runStartupCommands(worktreeWorkspaceRoot: string) {
  const startupCommands = await loadStartupCommands();
  for (const command of startupCommands) {
    const shellCommand = process.platform === "win32" ? "cmd.exe" : "sh";
    const shellArgs =
      process.platform === "win32"
        ? ["/d", "/s", "/c", command]
        : ["-lc", command];
    const result = await runCommand(
      shellCommand,
      shellArgs,
      worktreeWorkspaceRoot
    );

    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.trim() ||
          result.stdout.trim() ||
          `Startup command failed: ${command}`
      );
    }
  }
}

async function createBlankPlanFile(worktreeWorkspaceRoot: string) {
  const planPath = path.join(worktreeWorkspaceRoot, ".agents", "PLAN.md");
  await fs.mkdir(path.dirname(planPath), { recursive: true });
  await fs.writeFile(planPath, "", "utf-8");
}

async function createWorktreeSession(gitRoot: string) {
  const sessionRoot = sessionStorageRoot
    ? sessionStorageRoot
    : await fs.mkdtemp(path.join(os.tmpdir(), "agent-cli-worktree-"));
  const worktreeRoot = path.join(sessionRoot, "tree");
  const baselinesRoot = path.join(sessionRoot, "baselines");
  const workspaceRelativePath = path.relative(gitRoot, ORIGINAL_WORKSPACE_ROOT);
  const worktreeWorkspaceRoot =
    workspaceRelativePath.length > 0
      ? path.join(worktreeRoot, workspaceRelativePath)
      : worktreeRoot;

  if (sessionStorageRoot) {
    await fs.rm(sessionRoot, { recursive: true, force: true });
    await fs.mkdir(sessionRoot, { recursive: true });
  }

  const addResult = await runCommand(
    "git",
    ["worktree", "add", "--detach", worktreeRoot, "HEAD"],
    gitRoot
  );

  if (addResult.exitCode !== 0) {
    throw new Error(addResult.stderr.trim() || "Failed to create a git worktree.");
  }

  await fs.mkdir(baselinesRoot, { recursive: true });
  await syncWorkspaceChangesIntoWorktree(worktreeWorkspaceRoot);
  await createBlankPlanFile(worktreeWorkspaceRoot);
  await runStartupCommands(worktreeWorkspaceRoot);

  sessionState = {
    initialized: true,
    mode: "worktree",
    note: "Agent edits are isolated in a git worktree until you upmerge them.",
    trackedFiles: sessionState.trackedFiles,
    conflicts: sessionState.conflicts,
    gitRoot,
    sessionRoot,
    worktreeRoot,
    worktreeWorkspaceRoot,
    baselinesRoot,
  };

  return sessionState;
}

async function ensureSession() {
  if (sessionState.initialized) {
    return sessionState;
  }

  if (ensureSessionPromise) {
    return await ensureSessionPromise;
  }

  ensureSessionPromise = (async () => {
    const gitRoot = await detectGitRoot();
    if (!gitRoot) {
      sessionState = {
        initialized: true,
        mode: "direct",
        note: "Git worktrees are unavailable here, so edits apply directly.",
        trackedFiles: sessionState.trackedFiles,
        conflicts: sessionState.conflicts,
      };
      return sessionState;
    }

    return await createWorktreeSession(gitRoot);
  })();

  try {
    return await ensureSessionPromise;
  } finally {
    ensureSessionPromise = null;
  }
}

function getBaselineRecord(relativePath: string) {
  return sessionState.trackedFiles.get(relativePath) ?? null;
}

function getConflictRecord(relativePath: string) {
  return sessionState.conflicts.get(relativePath) ?? null;
}

function setConflictRecord(relativePath: string, record: UpmergeConflictRecord) {
  sessionState.conflicts.set(relativePath, record);
}

function clearConflictRecord(relativePath: string) {
  sessionState.conflicts.delete(relativePath);
}

async function writeBaseline(relativePath: string, contentPath: string | null) {
  if (sessionState.mode !== "worktree") {
    return;
  }

  const baselinePath = path.join(sessionState.baselinesRoot, relativePath);
  const record: BaselineRecord =
    contentPath === null
      ? {
          baselinePath: null,
          exists: false,
        }
      : {
          baselinePath,
          exists: true,
        };

  if (contentPath === null) {
    await fs.rm(baselinePath, { force: true });
  } else {
    await fs.mkdir(path.dirname(baselinePath), { recursive: true });
    await fs.copyFile(contentPath, baselinePath);
  }

  sessionState.trackedFiles.set(relativePath, record);
}

function hasConflictMarkers(content: Buffer | null) {
  if (content === null) {
    return false;
  }

  const text = content.toString("utf8");
  return text.includes("<<<<<<< ") || text.includes("=======") || text.includes(">>>>>>> ");
}

function buildConflictPreview(text: string, contextLines = 8) {
  const lines = text.split("\n");
  const conflictLineIndexes = lines.flatMap((line, index) =>
    line.startsWith("<<<<<<< ") || line === "=======" || line.startsWith(">>>>>>> ")
      ? [index]
      : []
  );

  if (!conflictLineIndexes.length) {
    return text.length > 4000 ? `${text.slice(0, 4000)}\n\n... preview truncated ...` : text;
  }

  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of conflictLineIndexes) {
    const start = Math.max(0, index - contextLines);
    const end = Math.min(lines.length - 1, index + contextLines);
    const previous = ranges[ranges.length - 1];
    if (previous && start <= previous.end + 1) {
      previous.end = Math.max(previous.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  return ranges
    .map((range, rangeIndex) => {
      const chunk = lines.slice(range.start, range.end + 1).join("\n");
      const header = `--- conflict region ${rangeIndex + 1} (${range.start + 1}-${range.end + 1}) ---`;
      return `${header}\n${chunk}`;
    })
    .join("\n\n...\n\n");
}

async function syncResolvedVersionIntoWorktree(relativePath: string, content: Buffer | null) {
  if (sessionState.mode !== "worktree") {
    return;
  }

  const worktreePath = path.join(sessionState.worktreeWorkspaceRoot, relativePath);
  await writeWorkspaceVersion(worktreePath, content);
}

async function buildDiffFromPaths(relativePath: string, beforePath: string | null, afterPath: string) {
  const labelPath = toPortablePath(relativePath);
  const args = [
    "diff",
    "--no-index",
    "--binary",
    "--no-ext-diff",
    beforePath ?? DEV_NULL_PATH,
    afterPath,
  ];
  const result = await runCommand("git", args, ORIGINAL_WORKSPACE_ROOT);

  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(result.stderr.trim() || `Failed to generate a diff for ${relativePath}.`);
  }

  const beforeLabel = beforePath === null ? "/dev/null" : `a/${labelPath}`;
  const afterLabel = `b/${labelPath}`;

  return result.stdout
    .replace(/^diff --git .+$/m, `diff --git a/${labelPath} ${afterLabel}`)
    .replace(/^--- .+$/m, `--- ${beforeLabel}`)
    .replace(/^\+\+\+ .+$/m, `+++ ${afterLabel}`)
    .trim();
}

async function hasPendingDiff(relativePath: string) {
  if (sessionState.mode !== "worktree") {
    return false;
  }

  const record = getBaselineRecord(relativePath);
  if (!record) {
    return false;
  }

  const worktreePath = path.join(sessionState.worktreeWorkspaceRoot, relativePath);
  return !(await filesEqual(record.baselinePath, worktreePath));
}

async function getPatchForRelativePath(relativePath: string) {
  if (sessionState.mode !== "worktree") {
    return "";
  }

  const record = getBaselineRecord(relativePath);
  if (!record) {
    return "";
  }

  const worktreePath = path.join(sessionState.worktreeWorkspaceRoot, relativePath);
  const pending = await hasPendingDiff(relativePath);
  if (!pending) {
    return "";
  }

  return await buildDiffFromPaths(relativePath, record.baselinePath, worktreePath);
}

async function readWorkspaceVersion(targetPath: string | null) {
  if (targetPath === null) {
    return {
      exists: false,
      content: null,
    };
  }

  const content = await readFileIfExists(targetPath);
  return {
    exists: content !== null,
    content,
  };
}

async function writeWorkspaceVersion(targetPath: string, content: Buffer | null) {
  if (content === null) {
    await fs.rm(targetPath, { force: true });
    return;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content);
}

async function mergeTextFileVersions(
  relativePath: string,
  currentContent: Buffer | null,
  baselineContent: Buffer | null,
  editedContent: Buffer | null
) {
  const mergeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cli-merge-"));
  const currentPath = path.join(mergeRoot, "current");
  const baselinePath = path.join(mergeRoot, "baseline");
  const editedPath = path.join(mergeRoot, "edited");

  try {
    await Promise.all([
      fs.writeFile(currentPath, currentContent ?? ""),
      fs.writeFile(baselinePath, baselineContent ?? ""),
      fs.writeFile(editedPath, editedContent ?? ""),
    ]);

    const result = await runCommand(
      "git",
      [
        "merge-file",
        "--stdout",
        "-L",
        `current/${toPortablePath(relativePath)}`,
        "-L",
        `baseline/${toPortablePath(relativePath)}`,
        "-L",
        `edited/${toPortablePath(relativePath)}`,
        currentPath,
        baselinePath,
        editedPath,
      ],
      ORIGINAL_WORKSPACE_ROOT
    );

    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error(result.stderr.trim() || `Failed to merge ${relativePath}.`);
    }

    return {
      content: Buffer.from(result.stdout, "utf8"),
      hasConflicts: result.exitCode === 1,
    };
  } finally {
    await fs.rm(mergeRoot, { recursive: true, force: true });
  }
}

async function advanceBaseline(relativePath: string) {
  if (sessionState.mode !== "worktree") {
    return;
  }

  const worktreePath = path.join(sessionState.worktreeWorkspaceRoot, relativePath);
  const stat = await statIfExists(worktreePath);
  await writeBaseline(relativePath, stat?.isFile() ? worktreePath : null);
}

function getOriginalWorkspaceRoot() {
  return ORIGINAL_WORKSPACE_ROOT;
}

function setWorkspaceSessionStorageRoot(storageRoot: string | null) {
  sessionStorageRoot = storageRoot;
}

function captureWorkspaceSession(): PersistedWorkspaceSession | null {
  if (sessionState.mode !== "worktree") {
    return null;
  }

  return {
    version: 1,
    mode: "worktree",
    note: sessionState.note,
    trackedFiles: [...sessionState.trackedFiles.entries()].map(
      ([relativePath, record]) => ({
        relativePath,
        baselinePath: record.baselinePath,
        exists: record.exists,
      })
    ),
    conflicts: [...sessionState.conflicts.entries()].map(([relativePath, record]) => ({
      relativePath,
      type: record.type,
      status: record.status,
    })),
    gitRoot: sessionState.gitRoot,
    sessionRoot: sessionState.sessionRoot,
    worktreeRoot: sessionState.worktreeRoot,
    worktreeWorkspaceRoot: sessionState.worktreeWorkspaceRoot,
    baselinesRoot: sessionState.baselinesRoot,
  };
}

function restoreWorkspaceSession(session: PersistedWorkspaceSession | null) {
  ensureSessionPromise = null;

  if (!session) {
    sessionState = {
      initialized: false,
      mode: "direct",
      note: "A git worktree will be created on the first edit when available.",
      trackedFiles: new Map(),
      conflicts: new Map(),
    };
    return;
  }

  sessionState = {
    initialized: true,
    mode: "worktree",
    note: session.note,
    trackedFiles: new Map(
      session.trackedFiles.map((entry) => [
        entry.relativePath,
        {
          baselinePath: entry.baselinePath,
          exists: entry.exists,
        },
      ])
    ),
    conflicts: new Map(
      session.conflicts.map((entry) => [
        entry.relativePath,
        {
          type: entry.type,
          status: entry.status,
        },
      ])
    ),
    gitRoot: session.gitRoot,
    sessionRoot: session.sessionRoot,
    worktreeRoot: session.worktreeRoot,
    worktreeWorkspaceRoot: session.worktreeWorkspaceRoot,
    baselinesRoot: session.baselinesRoot,
  };
}

function getActiveWorkspaceRoot() {
  return sessionState.mode === "worktree"
    ? sessionState.worktreeWorkspaceRoot
    : ORIGINAL_WORKSPACE_ROOT;
}

function getActiveWorkspaceAbsolutePath() {
  return getActiveWorkspaceRoot();
}

function resolveOriginalWorkspacePath(targetPath: string) {
  return resolvePathWithinRoot(ORIGINAL_WORKSPACE_ROOT, targetPath);
}

function relativeOriginalWorkspacePath(targetPath: string) {
  const relative = path.relative(ORIGINAL_WORKSPACE_ROOT, targetPath);
  return relative || ".";
}

async function prepareWorkspaceForEdit() {
  return await ensureSession();
}

async function trackEditTarget(targetPath: string) {
  const session = await ensureSession();
  if (session.mode !== "worktree") {
    return {
      mode: session.mode,
      relativePath: relativeOriginalWorkspacePath(resolveOriginalWorkspacePath(targetPath)),
    };
  }

  const originalPath = resolveOriginalWorkspacePath(targetPath);
  const relativePath = relativeOriginalWorkspacePath(originalPath);
  if (session.trackedFiles.has(relativePath)) {
    return {
      mode: session.mode,
      relativePath,
    };
  }

  const stat = await statIfExists(originalPath);
  await writeBaseline(relativePath, stat?.isFile() ? originalPath : null);
  return {
    mode: session.mode,
    relativePath,
  };
}

async function getWorktreeMergeConflictPaths() {
  const session = await ensureSession();
  if (session.mode !== "worktree") {
    return [] as string[];
  }

  const statusResult = await runCommand("git", ["status", "--short"], session.worktreeRoot);
  if (statusResult.exitCode !== 0) {
    throw new Error(statusResult.stderr.trim() || "Failed to inspect worktree merge status.");
  }

  return statusResult.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .flatMap((line) => {
      const code = line.slice(0, 2);
      const isConflict =
        code === "UU" ||
        code === "AA" ||
        code === "DD" ||
        code === "AU" ||
        code === "UA" ||
        code === "DU" ||
        code === "UD";
      if (!isConflict) {
        return [];
      }

      const rawPath = line.slice(3).trim();
      const relativePath = rawPath.includes(" -> ")
        ? rawPath.split(" -> ").at(-1)?.trim() ?? rawPath
        : rawPath;
      return relativePath ? [relativePath] : [];
    });
}

async function refreshWorktreeMergeConflicts() {
  const session = await ensureSession();
  if (session.mode !== "worktree") {
    return [] as UpmergeConflictStatus[];
  }

  const conflictedPaths = await getWorktreeMergeConflictPaths();
  const activePaths = new Set(conflictedPaths);

  for (const [relativePath, record] of session.conflicts.entries()) {
    if (record.phase === "sync-down" && !activePaths.has(relativePath)) {
      clearConflictRecord(relativePath);
    }
  }

  const conflicts: UpmergeConflictStatus[] = [];
  for (const relativePath of conflictedPaths) {
    const worktreePath = path.join(session.worktreeWorkspaceRoot, relativePath);
    const content = await readFileIfExists(worktreePath);
    const type = isProbablyBinary(content) ? "binary" : "text";
    setConflictRecord(relativePath, {
      type,
      status: "pending",
      phase: "sync-down",
    });
    conflicts.push({
      path: relativePath,
      type,
      status: "pending",
      phase: "sync-down",
    });
  }

  conflicts.sort((left, right) => left.path.localeCompare(right.path));
  return conflicts;
}

async function hasPendingSyncDownConflicts() {
  const conflicts = await refreshWorktreeMergeConflicts();
  return conflicts.length > 0;
}

async function collectTrackedWorktreePathsForMerge() {
  if (sessionState.mode !== "worktree") {
    return [] as string[];
  }

  const pathsToStage = new Set<string>();
  for (const [relativePath, record] of sessionState.trackedFiles.entries()) {
    if (shouldIgnoreUpmergePath(relativePath)) {
      continue;
    }

    if (await hasPendingDiff(relativePath)) {
      pathsToStage.add(relativePath);
      continue;
    }

    if (getConflictRecord(relativePath)?.phase === "sync-down") {
      pathsToStage.add(relativePath);
      continue;
    }

    if (!record.exists) {
      const worktreePath = path.join(sessionState.worktreeWorkspaceRoot, relativePath);
      if ((await statIfExists(worktreePath)) === null) {
        pathsToStage.add(relativePath);
      }
    }
  }

  return [...pathsToStage].sort((left, right) => left.localeCompare(right));
}

async function stageTrackedWorktreeFilesForMerge() {
  if (sessionState.mode !== "worktree") {
    return [] as string[];
  }

  const pathsToStage = await collectTrackedWorktreePathsForMerge();
  for (const relativePath of pathsToStage) {
    const addResult = await runCommand(
      "git",
      ["add", "--", relativePath],
      sessionState.worktreeRoot
    );
    if (addResult.exitCode !== 0) {
      throw new Error(addResult.stderr.trim() || `Failed to stage ${relativePath} before merge.`);
    }
  }

  return pathsToStage;
}

async function commitTrackedWorktreeFilesForMerge(sourceRef: string) {
  if (sessionState.mode !== "worktree") {
    return { created: false, stagedPaths: [] as string[], summary: "" };
  }

  const stagedPaths = await stageTrackedWorktreeFilesForMerge();
  if (!stagedPaths.length) {
    return { created: false, stagedPaths, summary: "" };
  }

  const commitMessage = `agent-cli: checkpoint before merging ${sourceRef}`;
  const commitResult = await runCommand(
    "git",
    ["commit", "--no-verify", "-m", commitMessage],
    sessionState.worktreeRoot
  );

  if (commitResult.exitCode !== 0) {
    throw new Error(
      commitResult.stderr.trim() ||
        commitResult.stdout.trim() ||
        `Failed to create a temporary checkpoint commit before merging ${sourceRef}.`
    );
  }

  return {
    created: true,
    stagedPaths,
    summary: [commitResult.stdout.trim(), commitResult.stderr.trim()].filter(Boolean).join("\n"),
  };
}

async function mergeSourceIntoWorktree(options?: {
  sourceRef?: string;
  remote?: string;
  branch?: string;
}) {
  const session = await ensureSession();
  if (session.mode !== "worktree") {
    return session.note;
  }

  const sourceRef =
    typeof options?.sourceRef === "string" && options.sourceRef.trim()
      ? options.sourceRef.trim()
      : null;
  const remote =
    typeof options?.remote === "string" && options.remote.trim()
      ? options.remote.trim()
      : null;
  const branch =
    typeof options?.branch === "string" && options.branch.trim()
      ? options.branch.trim()
      : null;

  let resolvedSource = sourceRef;
  if (!resolvedSource && remote && branch) {
    resolvedSource = `${remote}/${branch}`;
  } else if (!resolvedSource && branch) {
    resolvedSource = branch;
  }

  if (!resolvedSource) {
    const branchResult = await runCommand(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      ORIGINAL_WORKSPACE_ROOT
    );
    if (branchResult.exitCode !== 0) {
      throw new Error(
        branchResult.stderr.trim() || "Failed to determine the current source branch."
      );
    }

    const currentBranch = branchResult.stdout.trim();
    resolvedSource = currentBranch === "HEAD" ? "HEAD" : `origin/${currentBranch}`;
  }

  const checkpoint = await commitTrackedWorktreeFilesForMerge(resolvedSource);

  const mergeResult = await runCommand(
    "git",
    ["merge", "--no-edit", "--no-ff", resolvedSource],
    session.worktreeRoot
  );

  const summaryLines = [
    `Merged source ref \`${resolvedSource}\` into the agent worktree.`,
  ];
  if (checkpoint.created) {
    summaryLines.push(
      "",
      `Created a temporary checkpoint commit for tracked worktree edits before merging \`${resolvedSource}\`.`,
      `Checkpointed paths: ${checkpoint.stagedPaths.join(", ") || "(none)"}`
    );
  }

  const stdout = mergeResult.stdout.trim();
  const stderr = mergeResult.stderr.trim();

  if (mergeResult.exitCode === 0) {
    await refreshWorktreeMergeConflicts();
    if (stdout) {
      summaryLines.push("", "Stdout:", stdout);
    }
    if (stderr) {
      summaryLines.push("", "Stderr:", stderr);
    }
    return summaryLines.join("\n");
  }

  const conflicts = await refreshWorktreeMergeConflicts();
  const hasConflicts = conflicts.length > 0;
  const statusResult = await runCommand("git", ["status", "--short"], session.worktreeRoot);
  const statusOutput = statusResult.stdout.trim();

  if (hasConflicts) {
    const lines = [
      `Merge conflict while merging \`${resolvedSource}\` into the agent worktree.`,
      "Resolve conflicts in the worktree before publishing changes back to the main workspace.",
    ];
    if (stdout) {
      lines.push("", "Stdout:", stdout);
    }
    if (stderr) {
      lines.push("", "Stderr:", stderr);
    }
    if (statusOutput) {
      lines.push("", "git status --short:", statusOutput);
    }
    return lines.join("\n");
  }

  throw new Error(
    stderr || stdout || `Failed to merge ${resolvedSource} into the agent worktree.`
  );
}

async function getUpmergeStatus(): Promise<UpmergeStatus> {
  if (sessionState.mode === "worktree") {
    await refreshWorktreeMergeConflicts();
    const pendingFiles: string[] = [];
    const conflictedFiles: UpmergeConflictStatus[] = [];
    for (const relativePath of sessionState.trackedFiles.keys()) {
      if (shouldIgnoreUpmergePath(relativePath)) {
        continue;
      }

      const conflict = getConflictRecord(relativePath);
      if (conflict) {
        conflictedFiles.push({
          path: relativePath,
          type: conflict.type,
          status: conflict.status,
          phase: conflict.phase ?? "publish",
        });
        continue;
      }

      if (await hasPendingDiff(relativePath)) {
        pendingFiles.push(relativePath);
      }
    }

    pendingFiles.sort((left, right) => left.localeCompare(right));
    conflictedFiles.sort((left, right) => left.path.localeCompare(right.path));
    return {
      mode: "worktree",
      note: sessionState.note,
      pendingFiles,
      conflictedFiles,
    };
  }

  if (!sessionState.initialized) {
    const gitRoot = await detectGitRoot();
    return {
      mode: "direct",
      note: gitRoot
        ? "A git worktree will be created on the first edit."
        : "Git worktrees are unavailable here, so edits apply directly.",
      pendingFiles: [],
      conflictedFiles: [],
    };
  }

  return {
    mode: "direct",
    note: sessionState.note,
    pendingFiles: [],
    conflictedFiles: [],
  };
}

async function getUpmergePreview(relativePath?: string): Promise<string> {
  const status = await getUpmergeStatus();
  if (status.mode !== "worktree") {
    return `${status.note}\n\nThere are no pending upmerges.`;
  }

  if (relativePath) {
    const conflict = getConflictRecord(relativePath);
    if (conflict) {
      if (conflict.phase === "sync-down") {
        if (conflict.type === "binary") {
          return [
            `Binary worktree merge conflict: ${relativePath}`,
            "",
            "Automatic merge is not possible for this file.",
            "Resolve the file in the worktree before publishing.",
            "Quick actions:",
            "- 1 / accept-main: take the main/source version into the worktree",
            "- 2 / accept-worktree: keep the current worktree version when possible",
            "- m / mark-resolved: after manually resolving and staging in the worktree",
            "- r / revert: discard the agent/worktree side",
            "- a / auto-resolve: unavailable for binary conflicts",
          ].join("\n");
        }

        if (sessionState.mode !== "worktree") {
          return "Worktree merge conflict preview is unavailable because the worktree session is inactive.";
        }

        const worktreePath = path.join(sessionState.worktreeWorkspaceRoot, relativePath);
        const current = await readWorkspaceVersion(worktreePath);
        const text = current.content?.toString("utf8") ?? "";
        return [
          `Text worktree merge conflict: ${relativePath}`,
          "",
          "This file has merge markers in the agent worktree.",
          "Resolve it in the worktree, then use mark-resolved.",
          "Quick actions:",
          "- 1 / accept-main: take the main/source version into the worktree",
          "- 2 / accept-worktree: keep the current worktree version",
          "- a / auto-resolve: ask the current model to write a resolved file from git base/ours/theirs",
          "- m / mark-resolved: after manually resolving and staging in the worktree",
          "- r / revert: discard the agent/worktree side",
          "",
          buildConflictPreview(text),
        ].join("\n");
      }

      if (conflict.type === "binary") {
        return [
          `Binary upmerge conflict: ${relativePath}`,
          "",
          "Automatic merge is not possible for this file.",
          "Quick actions:",
          "- 1 / accept-main: keep the current main workspace version",
          "- 2 / accept-worktree: overwrite main with the worktree version",
          "- m / mark-resolved: after manually replacing the file in the main workspace",
          "- r / revert: discard the agent/worktree side",
        ].join("\n");
      }

      const originalPath = path.join(ORIGINAL_WORKSPACE_ROOT, relativePath);
      const current = await readWorkspaceVersion(originalPath);
      const text = current.content?.toString("utf8") ?? "";
      return [
        `Text upmerge conflict: ${relativePath}`,
        "",
        "The main workspace file currently contains conflict markers.",
        "Resolve the file in the main workspace, then use mark-resolved.",
        "Quick actions: 1 keep main, 2 keep worktree, r revert agent changes.",
        "",
        buildConflictPreview(text),
      ].join("\n");
    }
  }

  const selectedPaths = relativePath
    ? [relativePath]
    : [...status.pendingFiles, ...status.conflictedFiles.map((entry) => entry.path)];
  if (!selectedPaths.length) {
    return "No pending upmerges.";
  }

  const patches = await Promise.all(
    selectedPaths.map(async (entry) => {
      const conflict = getConflictRecord(entry);
      if (conflict) {
        return await getUpmergePreview(entry);
      }
      return await getPatchForRelativePath(entry);
    })
  );
  const combined = patches.filter(Boolean).join("\n\n");
  return combined || "No pending upmerges.";
}

async function upmergeRelativePath(relativePath: string) {
  const status = await getUpmergeStatus();
  if (status.mode !== "worktree") {
    return status.note;
  }
  if (sessionState.mode !== "worktree") {
    return status.note;
  }

  const activeConflict = getConflictRecord(relativePath);
  if (activeConflict) {
    if (activeConflict.phase === "sync-down") {
      return `Worktree merge conflict for ${relativePath} is still pending. Resolve it in the worktree before publishing.`;
    }
    return `Upmerge conflict for ${relativePath} is still pending. Resolve it before retrying.`;
  }

  if (await hasPendingSyncDownConflicts()) {
    return "Worktree merge conflicts are pending. Resolve them in the worktree before publishing changes back to the main workspace.";
  }

  const record = getBaselineRecord(relativePath);
  if (!record) {
    return `No pending changes for ${relativePath}.`;
  }

  const originalPath = path.join(ORIGINAL_WORKSPACE_ROOT, relativePath);
  const worktreePath = path.join(sessionState.worktreeWorkspaceRoot, relativePath);
  const [baseline, current, edited] = await Promise.all([
    readWorkspaceVersion(record.baselinePath),
    readWorkspaceVersion(originalPath),
    readWorkspaceVersion(worktreePath),
  ]);

  if (buffersEqual(baseline.content, edited.content)) {
    clearConflictRecord(relativePath);
    return `No pending changes for ${relativePath}.`;
  }

  if (buffersEqual(current.content, edited.content)) {
    clearConflictRecord(relativePath);
    await advanceBaseline(relativePath);
    return `Upmerged ${relativePath} into the main workspace.`;
  }

  if (buffersEqual(current.content, baseline.content)) {
    await writeWorkspaceVersion(originalPath, edited.content);
    clearConflictRecord(relativePath);
    await syncResolvedVersionIntoWorktree(relativePath, edited.content);
    await advanceBaseline(relativePath);
    return `Upmerged ${relativePath} into the main workspace.`;
  }

  if (
    isProbablyBinary(current.content) ||
    isProbablyBinary(baseline.content) ||
    isProbablyBinary(edited.content)
  ) {
    setConflictRecord(relativePath, {
      type: "binary",
      status: "pending",
      phase: "publish",
    });
    return `Upmerge conflict for ${relativePath}: both the main workspace and agent worktree changed a binary file. Resolve it with accept-main, accept-worktree, or mark-resolved after manually replacing the file.`;
  }

  const merged = await mergeTextFileVersions(
    relativePath,
    current.content,
    baseline.content,
    edited.content
  );

  if (merged.hasConflicts) {
    setConflictRecord(relativePath, {
      type: "text",
      status: "pending",
      phase: "publish",
    });
    return `Upmerge conflict for ${relativePath}: publishing was blocked because main changed after the worktree baseline. Merge main into the worktree again and resolve there before retrying.`;
  }

  await writeWorkspaceVersion(
    originalPath,
    !edited.exists && merged.content.length === 0 ? null : merged.content
  );
  clearConflictRecord(relativePath);
  await syncResolvedVersionIntoWorktree(
    relativePath,
    !edited.exists && merged.content.length === 0 ? null : merged.content
  );
  await advanceBaseline(relativePath);
  return `Upmerged ${relativePath} into the main workspace.`;
}

async function revertRelativePath(relativePath: string) {
  const status = await getUpmergeStatus();
  if (status.mode !== "worktree") {
    return status.note;
  }
  if (sessionState.mode !== "worktree") {
    return status.note;
  }

  const record = getBaselineRecord(relativePath);
  if (!record) {
    return `No pending changes for ${relativePath}.`;
  }

  const originalPath = path.join(ORIGINAL_WORKSPACE_ROOT, relativePath);
  const worktreePath = path.join(sessionState.worktreeWorkspaceRoot, relativePath);
  const current = await readWorkspaceVersion(originalPath);
  const conflict = getConflictRecord(relativePath);

  if (!conflict && !(await hasPendingDiff(relativePath))) {
    return `No pending changes for ${relativePath}.`;
  }

  await writeWorkspaceVersion(worktreePath, current.content);
  await writeBaseline(relativePath, current.exists ? originalPath : null);
  clearConflictRecord(relativePath);
  return `Reverted pending changes for ${relativePath}.`;
}

async function upmergeAll() {
  const status = await getUpmergeStatus();
  if (status.mode !== "worktree") {
    return status.note;
  }

  if (sessionState.mode !== "worktree") {
    return status.note;
  }

  if (await hasPendingSyncDownConflicts()) {
    return "Worktree merge conflicts are pending. Resolve them in the worktree before publishing changes back to the main workspace.";
  }

  const mergeMessage = await mergeSourceIntoWorktree();
  const results: string[] = [mergeMessage];

  if (await hasPendingSyncDownConflicts()) {
    return results.join("\n\n");
  }

  const refreshedStatus = await getUpmergeStatus();
  if (!refreshedStatus.pendingFiles.length && !refreshedStatus.conflictedFiles.length) {
    return results.join("\n\n");
  }

  for (const conflict of refreshedStatus.conflictedFiles) {
    if (conflict.phase === "sync-down") {
      return results.join("\n\n");
    }
  }
  for (const relativePath of refreshedStatus.pendingFiles) {
    try {
      results.push(await upmergeRelativePath(relativePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push(`Failed to upmerge ${relativePath}: ${message}`);
    }
  }

  for (const conflict of refreshedStatus.conflictedFiles) {
    results.push(
      `Pending ${conflict.phase === "sync-down" ? "worktree merge" : conflict.type} conflict for ${conflict.path}: resolve it before retrying upmerge all.`
    );
  }

  return results.join("\n");
}

async function getUnmergedStatusForPath(relativePath: string) {
  if (sessionState.mode !== "worktree") {
    return null;
  }

  const result = await runCommand(
    "git",
    ["status", "--short", "--", relativePath],
    sessionState.worktreeRoot
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `Failed to inspect merge status for ${relativePath}.`);
  }

  const line = result.stdout
    .split("\n")
    .map((entry) => entry.trimEnd())
    .find(Boolean);
  if (!line) {
    return null;
  }

  return line.slice(0, 2);
}

async function checkoutConflictStage(relativePath: string, stage: "ours" | "theirs") {
  if (sessionState.mode !== "worktree") {
    return;
  }

  const result = await runCommand(
    "git",
    ["checkout", `--${stage}`, "--", relativePath],
    sessionState.worktreeRoot
  );
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || `Failed to checkout ${stage} version for ${relativePath}.`
    );
  }

  const addResult = await runCommand(
    "git",
    ["add", "--", relativePath],
    sessionState.worktreeRoot
  );
  if (addResult.exitCode !== 0) {
    throw new Error(addResult.stderr.trim() || `Failed to stage resolved path ${relativePath}.`);
  }
}

async function stageResolvedWorktreePath(relativePath: string) {
  if (sessionState.mode !== "worktree") {
    return;
  }

  const addResult = await runCommand(
    "git",
    ["add", "--", relativePath],
    sessionState.worktreeRoot
  );
  if (addResult.exitCode !== 0) {
    throw new Error(addResult.stderr.trim() || `Failed to stage resolved path ${relativePath}.`);
  }
}

async function readConflictStageBlob(relativePath: string, stageNumber: 1 | 2 | 3) {
  if (sessionState.mode !== "worktree") {
    return null;
  }

  const result = await runCommand(
    "git",
    ["show", `:${stageNumber}:${relativePath}`],
    sessionState.worktreeRoot
  );
  if (result.exitCode !== 0) {
    return null;
  }

  return result.stdout;
}

function buildSyncDownAutoResolutionPrompt(options: {
  relativePath: string;
  conflictedText: string;
  baseText: string;
  ourText: string;
  theirText: string;
}) {
  return [
    `You are resolving a git merge conflict for ${options.relativePath}.`,
    "Return only the final resolved file contents with no markdown fences, commentary, or explanation.",
    "Preserve intent from both sides when possible and produce a clean merged result.",
    "",
    "Base version:",
    "<<<BASE>>>",
    options.baseText,
    "<<<END BASE>>>",
    "",
    "Our/worktree version:",
    "<<<OURS>>>",
    options.ourText,
    "<<<END OURS>>>",
    "",
    "Their/main version:",
    "<<<THEIRS>>>",
    options.theirText,
    "<<<END THEIRS>>>",
    "",
    "Current conflicted file:",
    "<<<CONFLICTED>>>",
    options.conflictedText,
    "<<<END CONFLICTED>>>",
  ].join("\n");
}

async function autoResolveSyncDownConflict(options: {
  relativePath: string;
  model: string;
  abortSignal?: AbortSignal;
}) {
  const status = await getUpmergeStatus();
  if (status.mode !== "worktree") {
    return status.note;
  }
  if (sessionState.mode !== "worktree") {
    return status.note;
  }

  const conflict = getConflictRecord(options.relativePath);
  if (!conflict || conflict.phase !== "sync-down") {
    return `No pending sync-down conflict for ${options.relativePath}.`;
  }
  if (conflict.type !== "text") {
    return `Automatic resolution is only supported for text sync-down conflicts. ${options.relativePath} is ${conflict.type}.`;
  }

  const worktreePath = path.join(sessionState.worktreeWorkspaceRoot, options.relativePath);
  const conflicted = await readWorkspaceVersion(worktreePath);
  if (!conflicted.content) {
    return `Cannot auto-resolve ${options.relativePath}: conflicted worktree file is unavailable.`;
  }

  const [baseText, ourText, theirText] = await Promise.all([
    readConflictStageBlob(options.relativePath, 1),
    readConflictStageBlob(options.relativePath, 2),
    readConflictStageBlob(options.relativePath, 3),
  ]);

  if (baseText === null || ourText === null || theirText === null) {
    return `Cannot auto-resolve ${options.relativePath}: missing git conflict stages for the file.`;
  }

  const prompt = buildSyncDownAutoResolutionPrompt({
    relativePath: options.relativePath,
    conflictedText: conflicted.content.toString("utf8"),
    baseText,
    ourText,
    theirText,
  });

  const resolvedText = await generateTextResponse({
    model: options.model,
    messages: [{ role: "user", content: prompt } satisfies Message],
    abortSignal: options.abortSignal,
  });

  await fs.writeFile(worktreePath, resolvedText, "utf8");
  if (hasConflictMarkers(Buffer.from(resolvedText, "utf8"))) {
    return `Automatic resolution for ${options.relativePath} still contains conflict markers. Review and resolve manually.`;
  }

  await stageResolvedWorktreePath(options.relativePath);
  const unmergedStatus = await getUnmergedStatusForPath(options.relativePath);
  if (unmergedStatus && /^(UU|AA|DD|AU|UA|DU|UD)$/.test(unmergedStatus)) {
    return `Automatic resolution for ${options.relativePath} did not finish cleanly: git still reports the path as unmerged.`;
  }

  clearConflictRecord(options.relativePath);
  return `Automatically resolved worktree merge conflict for ${options.relativePath} with model ${options.model}.`;
}

async function resolveUpmergeConflict(
  relativePath: string,
  strategy: UpmergeResolutionStrategy
) {
  const status = await getUpmergeStatus();
  if (status.mode !== "worktree") {
    return status.note;
  }
  if (sessionState.mode !== "worktree") {
    return status.note;
  }

  const conflict = getConflictRecord(relativePath);
  if (!conflict) {
    return `No pending conflict for ${relativePath}.`;
  }

  const originalPath = path.join(ORIGINAL_WORKSPACE_ROOT, relativePath);
  const worktreePath = path.join(sessionState.worktreeWorkspaceRoot, relativePath);
  const [current, edited] = await Promise.all([
    readWorkspaceVersion(originalPath),
    readWorkspaceVersion(worktreePath),
  ]);

  if (conflict.phase === "sync-down") {
    if (strategy === "accept-main") {
      await checkoutConflictStage(relativePath, "theirs");
      clearConflictRecord(relativePath);
      return `Resolved worktree merge conflict for ${relativePath} by taking the main/source version into the worktree.`;
    }

    if (strategy === "accept-worktree") {
      await checkoutConflictStage(relativePath, "ours");
      clearConflictRecord(relativePath);
      return `Resolved worktree merge conflict for ${relativePath} by keeping the current worktree version.`;
    }

    if (conflict.type === "text" && hasConflictMarkers(edited.content)) {
      return `Cannot mark ${relativePath} resolved yet: the worktree file still contains conflict markers.`;
    }

    await stageResolvedWorktreePath(relativePath);
    const unmergedStatus = await getUnmergedStatusForPath(relativePath);
    if (unmergedStatus && /^(UU|AA|DD|AU|UA|DU|UD)$/.test(unmergedStatus)) {
      return `Cannot mark ${relativePath} resolved yet: git still reports it as unmerged.`;
    }

    clearConflictRecord(relativePath);
    return `Marked worktree merge conflict for ${relativePath} as resolved.`;
  }

  if (strategy === "accept-main") {
    await syncResolvedVersionIntoWorktree(relativePath, current.content);
    await writeBaseline(relativePath, current.exists ? originalPath : null);
    clearConflictRecord(relativePath);
    return `Resolved upmerge conflict for ${relativePath} by keeping the main workspace version.`;
  }

  if (strategy === "accept-worktree") {
    await writeWorkspaceVersion(originalPath, edited.content);
    await syncResolvedVersionIntoWorktree(relativePath, edited.content);
    await advanceBaseline(relativePath);
    clearConflictRecord(relativePath);
    return `Resolved upmerge conflict for ${relativePath} by applying the worktree version.`;
  }

  if (conflict.type === "text" && hasConflictMarkers(current.content)) {
    return `Cannot mark ${relativePath} resolved yet: the main workspace file still contains conflict markers.`;
  }

  await syncResolvedVersionIntoWorktree(relativePath, current.content);
  await writeBaseline(relativePath, current.exists ? originalPath : null);
  clearConflictRecord(relativePath);
  return `Marked upmerge conflict for ${relativePath} as resolved.`;
}

async function cleanupWorkspaceSession(
  targetSession: PersistedWorkspaceSession | null = captureWorkspaceSession()
) {
  if (!targetSession) {
    return;
  }

  const { gitRoot, worktreeRoot, sessionRoot } = targetSession;
  await runCommand("git", ["worktree", "remove", "--force", worktreeRoot], gitRoot);
  await fs.rm(sessionRoot, { recursive: true, force: true });

  if (sessionState.mode === "worktree" && sessionState.sessionRoot === sessionRoot) {
    sessionState = createInitialSessionState();
    ensureSessionPromise = null;
  }
}

  return {
    getOriginalWorkspaceRoot,
    setWorkspaceSessionStorageRoot,
    captureWorkspaceSession,
    restoreWorkspaceSession,
    getActiveWorkspaceRoot,
    getActiveWorkspaceAbsolutePath,
    resolveOriginalWorkspacePath,
    relativeOriginalWorkspacePath,
    prepareWorkspaceForEdit,
    trackEditTarget,
    mergeSourceIntoWorktree,
    autoResolveSyncDownConflict,
    getUpmergeStatus,
    getUpmergePreview,
    upmergeRelativePath,
    revertRelativePath,
    upmergeAll,
    resolveUpmergeConflict,
    cleanupWorkspaceSession,
  };
}

const defaultWorkspaceSessionManager = createWorkspaceSessionManager();

export const {
  getOriginalWorkspaceRoot,
  setWorkspaceSessionStorageRoot,
  captureWorkspaceSession,
  restoreWorkspaceSession,
  getActiveWorkspaceRoot,
  getActiveWorkspaceAbsolutePath,
  resolveOriginalWorkspacePath,
  relativeOriginalWorkspacePath,
  prepareWorkspaceForEdit,
  trackEditTarget,
  mergeSourceIntoWorktree,
  autoResolveSyncDownConflict,
  getUpmergeStatus,
  getUpmergePreview,
  upmergeRelativePath,
  revertRelativePath,
  upmergeAll,
  resolveUpmergeConflict,
  cleanupWorkspaceSession,
} = defaultWorkspaceSessionManager;

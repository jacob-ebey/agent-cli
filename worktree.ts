import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const ORIGINAL_WORKSPACE_ROOT = process.cwd();
const DEV_NULL_PATH = "/dev/null";
const SHELL_CONFIG_PATH = path.join(ORIGINAL_WORKSPACE_ROOT, ".agents", "shell.json");

type BaselineRecord = {
  baselinePath: string | null;
  exists: boolean;
};

type SessionState =
  | {
      initialized: false;
      mode: "direct";
      note: string;
      trackedFiles: Map<string, BaselineRecord>;
    }
  | {
      initialized: true;
      mode: "direct";
      note: string;
      trackedFiles: Map<string, BaselineRecord>;
    }
  | {
      initialized: true;
      mode: "worktree";
      note: string;
      trackedFiles: Map<string, BaselineRecord>;
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
  gitRoot: string;
  sessionRoot: string;
  worktreeRoot: string;
  worktreeWorkspaceRoot: string;
  baselinesRoot: string;
};

export type UpmergeStatus = {
  mode: "direct" | "worktree";
  note: string;
  pendingFiles: string[];
};

let sessionState: SessionState = {
  initialized: false,
  mode: "direct",
  note: "A git worktree will be created on the first edit when available.",
  trackedFiles: new Map(),
};

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
  await runStartupCommands(worktreeWorkspaceRoot);

  sessionState = {
    initialized: true,
    mode: "worktree",
    note: "Agent edits are isolated in a git worktree until you upmerge them.",
    trackedFiles: sessionState.trackedFiles,
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

export function getOriginalWorkspaceRoot() {
  return ORIGINAL_WORKSPACE_ROOT;
}

export function setWorkspaceSessionStorageRoot(storageRoot: string | null) {
  sessionStorageRoot = storageRoot;
}

export function captureWorkspaceSession(): PersistedWorkspaceSession | null {
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
    gitRoot: sessionState.gitRoot,
    sessionRoot: sessionState.sessionRoot,
    worktreeRoot: sessionState.worktreeRoot,
    worktreeWorkspaceRoot: sessionState.worktreeWorkspaceRoot,
    baselinesRoot: sessionState.baselinesRoot,
  };
}

export function restoreWorkspaceSession(session: PersistedWorkspaceSession | null) {
  ensureSessionPromise = null;

  if (!session) {
    sessionState = {
      initialized: false,
      mode: "direct",
      note: "A git worktree will be created on the first edit when available.",
      trackedFiles: new Map(),
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
    gitRoot: session.gitRoot,
    sessionRoot: session.sessionRoot,
    worktreeRoot: session.worktreeRoot,
    worktreeWorkspaceRoot: session.worktreeWorkspaceRoot,
    baselinesRoot: session.baselinesRoot,
  };
}

export function getActiveWorkspaceRoot() {
  return sessionState.mode === "worktree"
    ? sessionState.worktreeWorkspaceRoot
    : ORIGINAL_WORKSPACE_ROOT;
}

export function resolveOriginalWorkspacePath(targetPath: string) {
  return resolvePathWithinRoot(ORIGINAL_WORKSPACE_ROOT, targetPath);
}

export function relativeOriginalWorkspacePath(targetPath: string) {
  const relative = path.relative(ORIGINAL_WORKSPACE_ROOT, targetPath);
  return relative || ".";
}

export async function prepareWorkspaceForEdit() {
  return await ensureSession();
}

export async function trackEditTarget(targetPath: string) {
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

export async function getUpmergeStatus(): Promise<UpmergeStatus> {
  if (sessionState.mode === "worktree") {
    const pendingFiles: string[] = [];
    for (const relativePath of sessionState.trackedFiles.keys()) {
      if (await hasPendingDiff(relativePath)) {
        pendingFiles.push(relativePath);
      }
    }

    pendingFiles.sort((left, right) => left.localeCompare(right));
    return {
      mode: "worktree",
      note: sessionState.note,
      pendingFiles,
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
    };
  }

  return {
    mode: "direct",
    note: sessionState.note,
    pendingFiles: [],
  };
}

export async function getUpmergePreview(relativePath?: string) {
  const status = await getUpmergeStatus();
  if (status.mode !== "worktree") {
    return `${status.note}\n\nThere are no pending upmerges.`;
  }

  const selectedPaths = relativePath ? [relativePath] : status.pendingFiles;
  if (!selectedPaths.length) {
    return "No pending upmerges.";
  }

  const patches = await Promise.all(selectedPaths.map((entry) => getPatchForRelativePath(entry)));
  const combined = patches.filter(Boolean).join("\n\n");
  return combined || "No pending upmerges.";
}

export async function upmergeRelativePath(relativePath: string) {
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
  const [baseline, current, edited] = await Promise.all([
    readWorkspaceVersion(record.baselinePath),
    readWorkspaceVersion(originalPath),
    readWorkspaceVersion(worktreePath),
  ]);

  if (buffersEqual(baseline.content, edited.content)) {
    return `No pending changes for ${relativePath}.`;
  }

  if (buffersEqual(current.content, edited.content)) {
    await advanceBaseline(relativePath);
    return `Upmerged ${relativePath} into the main workspace.`;
  }

  if (buffersEqual(current.content, baseline.content)) {
    await writeWorkspaceVersion(originalPath, edited.content);
    await advanceBaseline(relativePath);
    return `Upmerged ${relativePath} into the main workspace.`;
  }

  if (
    isProbablyBinary(current.content) ||
    isProbablyBinary(baseline.content) ||
    isProbablyBinary(edited.content)
  ) {
    throw new Error(
      `Upmerge conflict for ${relativePath}: both the main workspace and agent worktree changed a binary file.`
    );
  }

  const merged = await mergeTextFileVersions(
    relativePath,
    current.content,
    baseline.content,
    edited.content
  );

  if (merged.hasConflicts) {
    throw new Error(
      `Upmerge conflict for ${relativePath}: both the main workspace and agent worktree changed overlapping lines.`
    );
  }

  await writeWorkspaceVersion(
    originalPath,
    !edited.exists && merged.content.length === 0 ? null : merged.content
  );
  await advanceBaseline(relativePath);
  return `Upmerged ${relativePath} into the main workspace.`;
}

export async function revertRelativePath(relativePath: string) {
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

  if (!(await hasPendingDiff(relativePath))) {
    return `No pending changes for ${relativePath}.`;
  }

  const originalPath = path.join(ORIGINAL_WORKSPACE_ROOT, relativePath);
  const worktreePath = path.join(sessionState.worktreeWorkspaceRoot, relativePath);
  const current = await readWorkspaceVersion(originalPath);

  await writeWorkspaceVersion(worktreePath, current.content);
  await writeBaseline(relativePath, current.exists ? originalPath : null);
  return `Reverted pending changes for ${relativePath}.`;
}

export async function upmergeAll() {
  const status = await getUpmergeStatus();
  if (status.mode !== "worktree") {
    return status.note;
  }

  if (!status.pendingFiles.length) {
    return "No pending upmerges.";
  }

  const results: string[] = [];
  for (const relativePath of status.pendingFiles) {
    try {
      results.push(await upmergeRelativePath(relativePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push(`Failed to upmerge ${relativePath}: ${message}`);
    }
  }

  return results.join("\n");
}

export async function cleanupWorkspaceSession(
  targetSession: PersistedWorkspaceSession | null = captureWorkspaceSession()
) {
  if (!targetSession) {
    return;
  }

  const { gitRoot, worktreeRoot, sessionRoot } = targetSession;
  await runCommand("git", ["worktree", "remove", "--force", worktreeRoot], gitRoot);
  await fs.rm(sessionRoot, { recursive: true, force: true });

  if (sessionState.mode === "worktree" && sessionState.sessionRoot === sessionRoot) {
    sessionState = {
      initialized: false,
      mode: "direct",
      note: "A git worktree will be created on the first edit when available.",
      trackedFiles: new Map(),
    };
    ensureSessionPromise = null;
  }
}

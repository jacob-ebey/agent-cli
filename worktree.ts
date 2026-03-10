import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const ORIGINAL_WORKSPACE_ROOT = process.cwd();
const DEV_NULL_PATH = "/dev/null";

type BaselineRecord = {
  baselinePath: string | null;
  exists: boolean;
};

export type PendingLineChange = {
  id: string;
  relativePath: string;
  kind: "replace" | "add" | "remove";
  originalLineNumber: number;
  currentLineNumber: number;
  originalText: string | null;
  currentText: string | null;
  summary: string;
};

type ParsedDiffHunk = {
  originalStart: number;
  originalCount: number;
  currentStart: number;
  currentCount: number;
  removedLines: string[];
  addedLines: string[];
};

type TextDocument = {
  lines: string[];
  lineEnding: string;
  hadTrailingLineEnding: boolean;
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

export type UpmergeStatus = {
  mode: "direct" | "worktree";
  note: string;
  pendingFiles: string[];
  pendingLineChanges: PendingLineChange[];
};

let sessionState: SessionState = {
  initialized: false,
  mode: "direct",
  note: "A git worktree will be created on the first edit when available.",
  trackedFiles: new Map(),
};

let detectedGitRoot: string | null | undefined;
let ensureSessionPromise: Promise<SessionState> | null = null;

function toPortablePath(relativePath: string) {
  return relativePath.split(path.sep).join("/");
}

function clipLinePreview(value: string | null, maxLength = 48) {
  if (value === null) {
    return "";
  }

  const normalized = value.replace(/\t/g, "  ");
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function formatLineReference(lineNumber: number) {
  return lineNumber > 0 ? `line ${lineNumber}` : "start of file";
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

function deserializeTextDocument(raw: string): TextDocument {
  if (!raw.length) {
    return {
      lines: [],
      lineEnding: "\n",
      hadTrailingLineEnding: false,
    };
  }

  const lineEnding = raw.includes("\r\n") ? "\r\n" : "\n";
  const normalized = raw.replace(/\r\n/g, "\n");
  const hadTrailingLineEnding = normalized.endsWith("\n");
  const trimmed = hadTrailingLineEnding ? normalized.slice(0, -1) : normalized;

  return {
    lines: trimmed.length ? trimmed.split("\n") : [],
    lineEnding,
    hadTrailingLineEnding,
  };
}

function serializeTextDocument(document: TextDocument) {
  const body = document.lines.join(document.lineEnding);
  return document.hadTrailingLineEnding ? `${body}${document.lineEnding}` : body;
}

async function readTextDocumentIfExists(targetPath: string) {
  const raw = await readFileIfExists(targetPath);
  if (raw === null) {
    return null;
  }

  return deserializeTextDocument(raw.toString("utf-8"));
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

async function createWorktreeSession(gitRoot: string) {
  const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cli-worktree-"));
  const worktreeRoot = path.join(sessionRoot, "tree");
  const baselinesRoot = path.join(sessionRoot, "baselines");
  const workspaceRelativePath = path.relative(gitRoot, ORIGINAL_WORKSPACE_ROOT);
  const worktreeWorkspaceRoot =
    workspaceRelativePath.length > 0
      ? path.join(worktreeRoot, workspaceRelativePath)
      : worktreeRoot;

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

async function buildDiffFromPaths(
  relativePath: string,
  beforePath: string | null,
  afterPath: string,
  contextLines = 3
) {
  const labelPath = toPortablePath(relativePath);
  const args = [
    "diff",
    "--no-index",
    "--binary",
    "--no-ext-diff",
    `--unified=${contextLines}`,
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

function parseDiffCount(value: string | undefined) {
  return value === undefined ? 1 : Number(value);
}

function parseUnifiedDiffHunks(diff: string) {
  const hunks: ParsedDiffHunk[] = [];
  let current: ParsedDiffHunk | null = null;

  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!match) {
        continue;
      }

      current = {
        originalStart: Number(match[1]),
        originalCount: parseDiffCount(match[2]),
        currentStart: Number(match[3]),
        currentCount: parseDiffCount(match[4]),
        removedLines: [],
        addedLines: [],
      };
      hunks.push(current);
      continue;
    }

    if (!current || !line.length || line.startsWith("\\")) {
      continue;
    }

    if (line.startsWith("-")) {
      current.removedLines.push(line.slice(1));
    } else if (line.startsWith("+")) {
      current.addedLines.push(line.slice(1));
    }
  }

  return hunks;
}

function summarizeLineChange(change: PendingLineChange) {
  switch (change.kind) {
    case "replace":
      return `${formatLineReference(change.originalLineNumber)} replace ${clipLinePreview(change.originalText)} -> ${clipLinePreview(change.currentText)}`;
    case "add":
      return `${formatLineReference(change.originalLineNumber)} add ${clipLinePreview(change.currentText)}`;
    case "remove":
      return `${formatLineReference(change.originalLineNumber)} remove ${clipLinePreview(change.originalText)}`;
  }
}

function buildPendingLineChanges(relativePath: string, diff: string) {
  const hunks = parseUnifiedDiffHunks(diff);
  const changes: PendingLineChange[] = [];

  hunks.forEach((hunk, hunkIndex) => {
    const pairedCount = Math.min(hunk.removedLines.length, hunk.addedLines.length);
    const extraRemoveCurrentLine = hunk.currentStart + pairedCount;
    const extraAddOriginalLine = hunk.originalStart + pairedCount;

    for (let index = 0; index < pairedCount; index += 1) {
      const change: PendingLineChange = {
        id: `${hunkIndex}:${changes.length}`,
        relativePath,
        kind: "replace",
        originalLineNumber: hunk.originalStart + index,
        currentLineNumber: hunk.currentStart + index,
        originalText: hunk.removedLines[index] ?? null,
        currentText: hunk.addedLines[index] ?? null,
        summary: "",
      };
      change.summary = summarizeLineChange(change);
      changes.push(change);
    }

    for (let index = pairedCount; index < hunk.removedLines.length; index += 1) {
      const change: PendingLineChange = {
        id: `${hunkIndex}:${changes.length}`,
        relativePath,
        kind: "remove",
        originalLineNumber: hunk.originalStart + index,
        currentLineNumber: extraRemoveCurrentLine,
        originalText: hunk.removedLines[index] ?? null,
        currentText: null,
        summary: "",
      };
      change.summary = summarizeLineChange(change);
      changes.push(change);
    }

    for (let index = pairedCount; index < hunk.addedLines.length; index += 1) {
      const change: PendingLineChange = {
        id: `${hunkIndex}:${changes.length}`,
        relativePath,
        kind: "add",
        originalLineNumber: extraAddOriginalLine,
        currentLineNumber: hunk.currentStart + index,
        originalText: null,
        currentText: hunk.addedLines[index] ?? null,
        summary: "",
      };
      change.summary = summarizeLineChange(change);
      changes.push(change);
    }
  });

  return changes;
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

async function getPendingLineChangesForRelativePath(relativePath: string) {
  if (sessionState.mode !== "worktree") {
    return [] as PendingLineChange[];
  }

  const record = getBaselineRecord(relativePath);
  if (!record) {
    return [] as PendingLineChange[];
  }

  const worktreePath = path.join(sessionState.worktreeWorkspaceRoot, relativePath);
  const pending = await hasPendingDiff(relativePath);
  if (!pending) {
    return [] as PendingLineChange[];
  }

  const diff = await buildDiffFromPaths(relativePath, record.baselinePath, worktreePath, 0);
  return buildPendingLineChanges(relativePath, diff);
}

function lineIndexFromReference(lineNumber: number, lineCount: number) {
  if (lineNumber <= 0) {
    return 0;
  }

  return Math.min(lineNumber - 1, lineCount);
}

function assertLineValue(
  lines: string[],
  index: number,
  expected: string,
  label: string,
  relativePath: string
) {
  if (index < 0 || index >= lines.length) {
    throw new Error(`Unable to update ${relativePath}: ${label} is outside the file.`);
  }

  if (lines[index] !== expected) {
    throw new Error(`Unable to update ${relativePath}: ${label} no longer matches the expected text.`);
  }
}

function applyLineChangeToDocument(
  document: TextDocument,
  relativePath: string,
  change: PendingLineChange,
  direction: "upmerge" | "revert"
) {
  switch (change.kind) {
    case "replace": {
      const lineNumber =
        direction === "upmerge" ? change.originalLineNumber : change.currentLineNumber;
      const index = lineIndexFromReference(lineNumber, document.lines.length);
      const expected = direction === "upmerge" ? change.originalText : change.currentText;
      const next = direction === "upmerge" ? change.currentText : change.originalText;

      if (expected === null || next === null) {
        throw new Error(`Unable to update ${relativePath}: line change data is incomplete.`);
      }

      assertLineValue(
        document.lines,
        index,
        expected,
        formatLineReference(lineNumber),
        relativePath
      );
      document.lines[index] = next;
      return;
    }
    case "add": {
      if (direction === "upmerge") {
        if (change.currentText === null) {
          throw new Error(`Unable to update ${relativePath}: line change data is incomplete.`);
        }

        const index = lineIndexFromReference(change.originalLineNumber, document.lines.length);
        document.lines.splice(index, 0, change.currentText);
        return;
      }

      if (change.currentText === null) {
        throw new Error(`Unable to update ${relativePath}: line change data is incomplete.`);
      }

      const index = lineIndexFromReference(change.currentLineNumber, document.lines.length);
      assertLineValue(
        document.lines,
        index,
        change.currentText,
        formatLineReference(change.currentLineNumber),
        relativePath
      );
      document.lines.splice(index, 1);
      return;
    }
    case "remove": {
      if (direction === "upmerge") {
        if (change.originalText === null) {
          throw new Error(`Unable to update ${relativePath}: line change data is incomplete.`);
        }

        const index = lineIndexFromReference(change.originalLineNumber, document.lines.length);
        assertLineValue(
          document.lines,
          index,
          change.originalText,
          formatLineReference(change.originalLineNumber),
          relativePath
        );
        document.lines.splice(index, 1);
        return;
      }

      if (change.originalText === null) {
        throw new Error(`Unable to update ${relativePath}: line change data is incomplete.`);
      }

      const index = lineIndexFromReference(change.currentLineNumber, document.lines.length);
      document.lines.splice(index, 0, change.originalText);
    }
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

async function getPendingLineChange(relativePath: string, changeId: string) {
  const changes = await getPendingLineChangesForRelativePath(relativePath);
  return changes.find((change) => change.id === changeId) ?? null;
}

export function getOriginalWorkspaceRoot() {
  return ORIGINAL_WORKSPACE_ROOT;
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
    const pendingLineChanges: PendingLineChange[] = [];

    for (const relativePath of sessionState.trackedFiles.keys()) {
      if (!(await hasPendingDiff(relativePath))) {
        continue;
      }

      pendingFiles.push(relativePath);
      pendingLineChanges.push(...(await getPendingLineChangesForRelativePath(relativePath)));
    }

    pendingFiles.sort((left, right) => left.localeCompare(right));
    pendingLineChanges.sort(
      (left, right) =>
        left.relativePath.localeCompare(right.relativePath) ||
        left.originalLineNumber - right.originalLineNumber ||
        left.currentLineNumber - right.currentLineNumber ||
        left.id.localeCompare(right.id)
    );

    return {
      mode: "worktree",
      note: sessionState.note,
      pendingFiles,
      pendingLineChanges,
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
      pendingLineChanges: [],
    };
  }

  return {
    mode: "direct",
    note: sessionState.note,
    pendingFiles: [],
    pendingLineChanges: [],
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

export async function getUpmergeLinePreview(relativePath: string, changeId: string) {
  const status = await getUpmergeStatus();
  if (status.mode !== "worktree") {
    return `${status.note}\n\nThere are no pending upmerges.`;
  }

  const change = await getPendingLineChange(relativePath, changeId);
  if (!change) {
    return `No pending line change found for ${relativePath}.`;
  }

  return [
    relativePath,
    change.summary,
    "",
    change.originalText === null ? "- (no previous line)" : `- ${change.originalText}`,
    change.currentText === null ? "+ (line removed)" : `+ ${change.currentText}`,
  ].join("\n");
}

export async function upmergeRelativePath(relativePath: string) {
  const status = await getUpmergeStatus();
  if (status.mode !== "worktree") {
    return status.note;
  }

  const patch = await getPatchForRelativePath(relativePath);
  if (!patch) {
    return `No pending changes for ${relativePath}.`;
  }

  const result = await runCommand(
    "git",
    ["apply", "--whitespace=nowarn", "-"],
    ORIGINAL_WORKSPACE_ROOT,
    `${patch}\n`
  );

  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || `Failed to upmerge ${relativePath} into the main workspace.`
    );
  }

  await advanceBaseline(relativePath);
  return `Upmerged ${relativePath} into the main workspace.`;
}

export async function upmergeLineChange(relativePath: string, changeId: string) {
  const status = await getUpmergeStatus();
  if (status.mode !== "worktree") {
    return status.note;
  }

  if (sessionState.mode !== "worktree") {
    return status.note;
  }

  const change = await getPendingLineChange(relativePath, changeId);
  if (!change) {
    return `No pending line change found for ${relativePath}.`;
  }

  const targetPath = path.join(ORIGINAL_WORKSPACE_ROOT, relativePath);
  const worktreePath = path.join(sessionState.worktreeWorkspaceRoot, relativePath);
  const targetDocument = await readTextDocumentIfExists(targetPath);
  const worktreeDocument = await readTextDocumentIfExists(worktreePath);
  const document = targetDocument ?? {
    lines: [],
    lineEnding: worktreeDocument?.lineEnding ?? "\n",
    hadTrailingLineEnding: worktreeDocument?.hadTrailingLineEnding ?? false,
  };

  applyLineChangeToDocument(document, relativePath, change, "upmerge");
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, serializeTextDocument(document), "utf-8");
  await writeBaseline(relativePath, targetPath);

  return `Upmerged ${change.summary} from ${relativePath}.`;
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

export async function revertRelativePath(relativePath: string) {
  const status = await getUpmergeStatus();
  if (status.mode !== "worktree") {
    return status.note;
  }

  if (sessionState.mode !== "worktree") {
    return status.note;
  }

  const record = getBaselineRecord(relativePath);
  if (!record || !(await hasPendingDiff(relativePath))) {
    return `No pending changes for ${relativePath}.`;
  }

  const worktreePath = path.join(sessionState.worktreeWorkspaceRoot, relativePath);
  if (record.exists && record.baselinePath) {
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await fs.copyFile(record.baselinePath, worktreePath);
  } else {
    await fs.rm(worktreePath, { force: true });
  }

  return `Reverted pending changes for ${relativePath} in the agent worktree.`;
}

export async function revertLineChange(relativePath: string, changeId: string) {
  const status = await getUpmergeStatus();
  if (status.mode !== "worktree") {
    return status.note;
  }

  if (sessionState.mode !== "worktree") {
    return status.note;
  }

  const change = await getPendingLineChange(relativePath, changeId);
  if (!change) {
    return `No pending line change found for ${relativePath}.`;
  }

  const worktreePath = path.join(sessionState.worktreeWorkspaceRoot, relativePath);
  const document = (await readTextDocumentIfExists(worktreePath)) ?? {
    lines: [],
    lineEnding: "\n",
    hadTrailingLineEnding: false,
  };

  applyLineChangeToDocument(document, relativePath, change, "revert");
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await fs.writeFile(worktreePath, serializeTextDocument(document), "utf-8");

  return `Reverted ${change.summary} in ${relativePath}.`;
}

export async function cleanupWorkspaceSession() {
  if (sessionState.mode !== "worktree") {
    return;
  }

  const { gitRoot, worktreeRoot, sessionRoot } = sessionState;
  await runCommand("git", ["worktree", "remove", "--force", worktreeRoot], gitRoot);
  await fs.rm(sessionRoot, { recursive: true, force: true });
}

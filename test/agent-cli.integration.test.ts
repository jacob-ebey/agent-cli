import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const tempDirs: string[] = [];
const gitExecutable = Bun.which("git") ?? "git";

async function createTempGitRepo(files: Record<string, string>) {
  const tempRoot = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(tempRoot, "agent-cli-worktree-test-"));
  tempDirs.push(root);

  await runGit(["init"], root);
  await runGit(["config", "user.name", "agent-cli tests"], root);
  await runGit(["config", "user.email", "agent-cli@example.com"], root);

  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content, "utf8");
  }

  await runGit(["add", "."], root);
  await runGit(["commit", "-m", "initial"], root);
  return root;
}

async function runGit(args: string[], cwd: string) {
  const process = Bun.spawn([gitExecutable, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      [
        `git ${args.join(" ")} failed with exit code ${exitCode}`,
        stdout.trim(),
        stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  return stdout;
}

async function loadWorktreeModuleForRepo() {
  return await import(path.join(repoRoot, "worktree.ts"));
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("package.json exposes bun test script", async () => {
  const packageJson = await import(path.join(repoRoot, "package.json"), {
    with: { type: "json" },
  });

  expect(packageJson.default.scripts.test).toBe("bun test");
});

test("agent entrypoint imports its local modules and keeps the quit command wired", async () => {
  const source = await fs.readFile(path.join(repoRoot, "agent.ts"), "utf8");

  expect(source).toMatch(/import \{ createCliRenderer, type KeyEvent \} from "@opentui\/core";/);
  expect(source).toMatch(/await ensurePlanFileReady\(\)/);
  expect(source).toMatch(/command === "quit" \|\| command === "q"/);
  expect(source).toMatch(/async function shutdown\(\)/);
  expect(source).toMatch(/await persistActiveConversation\(\)/);
  expect(source).toMatch(/renderer\.destroy\(\)/);
});

test("merge source into worktree produces a realistic sync-down conflict with staged worktree edits", async () => {
  const repoPath = await createTempGitRepo({
    "notes.txt": ["start", "shared", "end", ""].join("\n"),
  });
  await runGit(["branch", "-M", "main"], repoPath);

  const upstreamPath = `${repoPath}-upstream.git`;
  await runGit(["init", "--bare", upstreamPath], repoPath);
  await runGit(["remote", "add", "origin", upstreamPath], repoPath);
  await runGit(["push", "-u", "origin", "main"], repoPath);

  const upstreamCheckout = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agent-cli-upstream-checkout-")
  );
  tempDirs.push(upstreamCheckout);
  await runGit(["clone", upstreamPath, upstreamCheckout], repoPath);
  await runGit(["checkout", "main"], upstreamCheckout);
  await runGit(["config", "user.name", "agent-cli tests"], upstreamCheckout);
  await runGit(["config", "user.email", "agent-cli@example.com"], upstreamCheckout);
  await fs.writeFile(
    path.join(upstreamCheckout, "notes.txt"),
    ["start", "main change", "end", ""].join("\n"),
    "utf8"
  );
  await runGit(["add", "notes.txt"], upstreamCheckout);
  await runGit(["commit", "-m", "main change"], upstreamCheckout);
  await runGit(["push", "origin", "main"], upstreamCheckout);
  await runGit(["fetch", "origin", "main"], repoPath);

  const worktreeModule = await loadWorktreeModuleForRepo();
  const worktree = worktreeModule.createWorkspaceSessionManager(path.resolve(repoPath));

  worktree.setWorkspaceSessionStorageRoot(path.join(repoPath, ".session-main"));
  worktree.restoreWorkspaceSession(null);
  await worktree.prepareWorkspaceForEdit();

  const mainPath = worktree.resolveOriginalWorkspacePath("notes.txt");
  await worktree.trackEditTarget("notes.txt");
  const worktreePath = path.join(worktree.getActiveWorkspaceRoot(), "notes.txt");
  await fs.writeFile(worktreePath, ["start", "worktree change", "end", ""].join("\n"), "utf8");

  const result = await worktree.mergeSourceIntoWorktree({ sourceRef: "origin/main" });
  expect(result).toContain("Merge conflict while merging `origin/main` into the agent worktree.");
  expect(result).toContain("Resolve conflicts in the worktree before publishing changes back to the main workspace.");

  expect(await fs.readFile(mainPath, "utf8")).toBe(["start", "shared", "end", ""].join("\n"));

  const conflictedWorktree = await fs.readFile(worktreePath, "utf8");
  expect(conflictedWorktree).toContain("<<<<<<< ");
  expect(conflictedWorktree).toContain("main change");
  expect(conflictedWorktree).toContain("worktree change");

  expect(await worktree.getUpmergeStatus()).toEqual({
    mode: "worktree",
    note: "Agent edits are isolated in a git worktree until you upmerge them.",
    pendingFiles: [],
    conflictedFiles: [
      { path: "notes.txt", type: "text", status: "pending", phase: "sync-down" },
    ],
  });

  const preview = await worktree.getUpmergePreview("notes.txt");
  expect(preview).toContain("Text worktree merge conflict: notes.txt");
  expect(preview).toContain("conflict region");

  const blockedPublish = await worktree.upmergeRelativePath("notes.txt");
  expect(blockedPublish).toContain("Resolve it in the worktree before publishing");

  await worktree.cleanupWorkspaceSession();
  worktree.restoreWorkspaceSession(null);
});

test("worktree publish conflicts no longer write conflict markers into main", async () => {
  const repoPath = await createTempGitRepo({
    "blob.bin": "base",
  });
  const worktreeModule = await loadWorktreeModuleForRepo();
  const worktree = worktreeModule.createWorkspaceSessionManager(path.resolve(repoPath));

  worktree.setWorkspaceSessionStorageRoot(path.join(repoPath, ".session-binary"));
  worktree.restoreWorkspaceSession(null);
  await worktree.prepareWorkspaceForEdit();

  const mainPath = worktree.resolveOriginalWorkspacePath("blob.bin");
  await worktree.trackEditTarget("blob.bin");
  const worktreePath = path.join(worktree.getActiveWorkspaceRoot(), "blob.bin");

  await fs.writeFile(worktreePath, Buffer.from([0, 1, 2, 3]));
  await fs.writeFile(mainPath, Buffer.from([0, 9, 9, 9]));

  const result = await worktree.upmergeRelativePath("blob.bin");
  expect(result).toContain("binary file");

  expect(await worktree.getUpmergeStatus()).toEqual({
    mode: "worktree",
    note: "Agent edits are isolated in a git worktree until you upmerge them.",
    pendingFiles: [],
    conflictedFiles: [
      { path: "blob.bin", type: "binary", status: "pending", phase: "publish" },
    ],
  });

  const preview = await worktree.getUpmergePreview("blob.bin");
  expect(preview).toContain("Binary upmerge conflict: blob.bin");
  expect(preview).toContain("accept-worktree");

  const resolution = await worktree.resolveUpmergeConflict("blob.bin", "accept-worktree");
  expect(resolution).toBe(
    "Resolved upmerge conflict for blob.bin by applying the worktree version."
  );

  expect(Buffer.from(await fs.readFile(mainPath))).toEqual(Buffer.from([0, 1, 2, 3]));
  expect(Buffer.from(await fs.readFile(worktreePath))).toEqual(Buffer.from([0, 1, 2, 3]));

  expect(await worktree.getUpmergeStatus()).toEqual({
    mode: "worktree",
    note: "Agent edits are isolated in a git worktree until you upmerge them.",
    pendingFiles: [],
    conflictedFiles: [],
  });

  await worktree.cleanupWorkspaceSession();
  worktree.restoreWorkspaceSession(null);
});

test("text publish conflicts no longer write conflict markers into main", async () => {
  const repoPath = await createTempGitRepo({
    "notes.txt": ["start", "shared", "end", ""].join("\n"),
  });
  const worktreeModule = await loadWorktreeModuleForRepo();
  const worktree = worktreeModule.createWorkspaceSessionManager(path.resolve(repoPath));

  worktree.setWorkspaceSessionStorageRoot(path.join(repoPath, ".session-publish-text"));
  worktree.restoreWorkspaceSession(null);
  await worktree.prepareWorkspaceForEdit();

  const mainPath = worktree.resolveOriginalWorkspacePath("notes.txt");
  await worktree.trackEditTarget("notes.txt");
  const worktreePath = path.join(worktree.getActiveWorkspaceRoot(), "notes.txt");

  await fs.writeFile(worktreePath, ["start", "worktree change", "end", ""].join("\n"), "utf8");
  await fs.writeFile(mainPath, ["start", "main change", "end", ""].join("\n"), "utf8");

  const result = await worktree.upmergeRelativePath("notes.txt");
  expect(result).toContain("publishing was blocked");
  expect(result).toContain("Merge main into the worktree again and resolve there before retrying.");

  expect(await fs.readFile(mainPath, "utf8")).toBe(["start", "main change", "end", ""].join("\n"));
  expect(await fs.readFile(worktreePath, "utf8")).toBe(["start", "worktree change", "end", ""].join("\n"));

  expect(await worktree.getUpmergeStatus()).toEqual({
    mode: "worktree",
    note: "Agent edits are isolated in a git worktree until you upmerge them.",
    pendingFiles: [],
    conflictedFiles: [
      { path: "notes.txt", type: "text", status: "pending", phase: "publish" },
    ],
  });

  const preview = await worktree.getUpmergePreview("notes.txt");
  expect(preview).toContain("Text upmerge conflict: notes.txt");
  expect(preview).not.toContain("conflict region");
  expect(preview).toContain("main change");
  expect(preview).not.toContain("<<<<<<< ");

  await worktree.cleanupWorkspaceSession();
  worktree.restoreWorkspaceSession(null);
});

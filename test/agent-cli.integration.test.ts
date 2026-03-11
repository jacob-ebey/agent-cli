import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

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

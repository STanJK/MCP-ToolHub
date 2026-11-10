import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  listProjectDirectory,
  MAX_DIRECTORY_ENTRIES
} from "../modules/local-build/directory-listing.mjs";

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "toolhub-list-directory-"));
  const root = path.join(base, "project");
  const outside = path.join(base, "outside");
  await mkdir(path.join(root, "assets", "nested"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(root, "README.md"), "root\n");
  await writeFile(path.join(root, "assets", "alpha.txt"), "alpha");
  await writeFile(path.join(root, "assets", "nested", "beta.txt"), "beta");
  return {
    base,
    root,
    outside,
    project: { root, operations: {} },
    async cleanup() { await rm(base, { recursive: true, force: true }); }
  };
}

async function withFixture(fn) {
  const value = await fixture();
  try { await fn(value); } finally { await value.cleanup(); }
}

test("lists project root with directories first", async () => withFixture(async ({ project }) => {
  const result = await listProjectDirectory({ projectId: "Test", project, requestedPath: "." });
  assert.equal(result.ok, true);
  assert.equal(result.path, ".");
  assert.deepEqual(result.entries.map((entry) => entry.name), ["assets", "README.md"]);
  assert.equal(result.entries[0].type, "directory");
  assert.equal(result.entries[1].type, "file");
}));

test("lists normal and nested relative directories", async () => withFixture(async ({ project }) => {
  const assets = await listProjectDirectory({ projectId: "Test", project, requestedPath: "assets" });
  assert.equal(assets.ok, true);
  assert.equal(assets.path, "assets");
  assert.deepEqual(assets.entries.map((entry) => entry.name), ["nested", "alpha.txt"]);

  const nested = await listProjectDirectory({ projectId: "Test", project, requestedPath: "assets/nested" });
  assert.equal(nested.ok, true);
  assert.equal(nested.path, "assets/nested");
  assert.deepEqual(nested.entries.map((entry) => entry.name), ["beta.txt"]);
}));

test("rejects parent traversal outside the project", async () => withFixture(async ({ project }) => {
  for (const requestedPath of ["..", "../outside"]) {
    const result = await listProjectDirectory({ projectId: "Test", project, requestedPath });
    assert.equal(result.ok, false);
    assert.equal(result.status, "refused");
  }
}));

test("rejects Windows, UNC, and POSIX absolute paths", async () => withFixture(async ({ project }) => {
  for (const requestedPath of ["C:\\Windows", "D:\\Temp", "\\\\server\\share", "/root"]) {
    const result = await listProjectDirectory({ projectId: "Test", project, requestedPath });
    assert.equal(result.ok, false, requestedPath);
    assert.equal(result.status, "refused", requestedPath);
  }
}));

test("returns not_directory for files and not_found for missing paths", async () => withFixture(async ({ project }) => {
  const file = await listProjectDirectory({ projectId: "Test", project, requestedPath: "README.md" });
  assert.equal(file.status, "not_directory");

  const missing = await listProjectDirectory({ projectId: "Test", project, requestedPath: "missing" });
  assert.equal(missing.status, "not_found");
}));

test("rejects a symlink or junction that resolves outside the project", async () => withFixture(async ({ root, outside, project }) => {
  const link = path.join(root, "assets", "external");
  await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");

  const result = await listProjectDirectory({ projectId: "Test", project, requestedPath: "assets/external" });
  assert.equal(result.ok, false);
  assert.equal(result.status, "refused");
  assert.match(result.message, /outside the project root/i);
  assert.equal(JSON.stringify(result).includes(outside), false);
}));

test("stably truncates directories larger than 500 entries", async () => withFixture(async ({ root, project }) => {
  const quarry = path.join(root, "assets", "quarry");
  await mkdir(path.join(quarry, "00-dir"), { recursive: true });
  await mkdir(path.join(quarry, "01-dir"), { recursive: true });
  await Promise.all(Array.from({ length: MAX_DIRECTORY_ENTRIES + 20 }, (_, index) =>
    writeFile(path.join(quarry, `file-${String(index).padStart(4, "0")}.txt`), String(index))
  ));

  const first = await listProjectDirectory({ projectId: "Test", project, requestedPath: "assets/quarry" });
  const second = await listProjectDirectory({ projectId: "Test", project, requestedPath: "assets/quarry" });

  assert.equal(first.truncated, true);
  assert.equal(first.entries.length, MAX_DIRECTORY_ENTRIES);
  assert.deepEqual(first.entries, second.entries);
  assert.deepEqual(first.entries.slice(0, 2).map((entry) => entry.name), ["00-dir", "01-dir"]);
}));

test("list_directory is exposed and remains available while cargo-build holds the project run lock", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "toolhub-list-directory-integration-"));
  const root = path.join(base, "project");
  const configPath = path.join(base, "local-build.json");
  await mkdir(path.join(root, "assets"), { recursive: true });
  await writeFile(path.join(root, "assets", "visible.txt"), "visible");
  await writeFile(configPath, JSON.stringify({
    version: 1,
    defaults: { timeout_ms: 10000, max_output_kb: 64 },
    projects: {
      LockTest: {
        root,
        operations: {
          "cargo-build": {
            program: process.execPath,
            args: ["-e", "setTimeout(() => {}, 10000)"]
          }
        }
      }
    }
  }));

  const createLocalBuildModule = (await import("../modules/local-build/index.mjs")).default;
  const module = await createLocalBuildModule({ moduleId: "local-build", configPath });
  const descriptor = await module.describe();
  assert.equal(descriptor.actions.some((action) => action.id === "list_directory"), true);

  const run = await module.invoke("run", { project: "LockTest", operation: "cargo-build" });
  assert.equal(run.ok, true);
  assert.equal(run.status, "running");

  try {
    const listing = await module.invoke("list_directory", { project: "LockTest", path: "assets" });
    assert.equal(listing.ok, true);
    assert.equal(listing.status, "completed");
    assert.deepEqual(listing.entries.map((entry) => entry.name), ["visible.txt"]);
  } finally {
    module.invoke("cancel_run", { run_id: run.run_id });
    for (let index = 0; index < 100; index += 1) {
      const snapshot = await module.invoke("get_run", { run_id: run.run_id });
      if (!["running", "cancelling", "cancel_failed"].includes(snapshot.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await rm(base, { recursive: true, force: true });
  }
});

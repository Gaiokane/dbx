import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectPackageEntries, formatFailure, main, readNodeLinker, scanLinkTopology } from "./check-node-modules-links.mjs";

function createWorkspace({ linker = "isolated", linked = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "dbx-node-modules-"));
  const nodeModules = path.join(root, "node_modules");
  const store = path.join(root, "store");
  mkdirSync(path.join(nodeModules, ".pnpm", "node_modules"), { recursive: true });
  mkdirSync(path.join(store, "vue"), { recursive: true });
  writeFileSync(path.join(nodeModules, ".modules.yaml"), `${JSON.stringify({ nodeLinker: linker, prunedAt: "now" }, null, 2)}\n`);

  const materialise = (target, source) => {
    if (linked) symlinkSync(source, target, "junction");
    else mkdirSync(target, { recursive: true });
  };
  materialise(path.join(nodeModules, "vue"), path.join(store, "vue"));
  mkdirSync(path.join(nodeModules, "@tauri-apps"), { recursive: true });
  materialise(path.join(nodeModules, "@tauri-apps", "cli"), path.join(store, "vue"));
  materialise(path.join(nodeModules, ".pnpm", "node_modules", "vue"), path.join(store, "vue"));
  return root;
}

test("a linked workspace passes the check", () => {
  const root = createWorkspace({ linked: true });
  try {
    assert.equal(main([root]), 0);
    const levels = scanLinkTopology(root);
    assert.equal(levels[0].realDirectories.length, 0);
    assert.equal(levels[0].links, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a workspace materialised as plain directories is reported with the affected paths and the fix", () => {
  const root = createWorkspace({ linked: false });
  try {
    assert.equal(main([root]), 1);
    const levels = scanLinkTopology(root);
    assert.equal(levels[0].realDirectories.length, 2);
    assert.equal(levels[1].realDirectories.length, 1);
    const report = formatFailure(root, levels);
    assert.match(report, /node_modules 链接拓扑损坏/);
    assert.match(report, /@tauri-apps[\\/]cli/);
    assert.match(report, /Remove-Item -Recurse -Force node_modules/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("layouts that do not use links are skipped instead of failing", () => {
  const root = createWorkspace({ linker: "hoisted", linked: false });
  try {
    assert.equal(readNodeLinker(root), "hoisted");
    assert.equal(main([root]), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing node_modules is skipped instead of failing", () => {
  const root = mkdtempSync(path.join(tmpdir(), "dbx-node-modules-empty-"));
  try {
    assert.equal(readNodeLinker(root), "unknown");
    assert.equal(main([root]), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scope directories are scanned one level deeper", () => {
  const root = createWorkspace({ linked: true });
  try {
    const entries = collectPackageEntries(path.join(root, "node_modules"));
    assert.deepEqual(entries.map((entry) => path.relative(root, entry).split(path.sep).join("/")).sort(), ["node_modules/@tauri-apps/cli", "node_modules/vue"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

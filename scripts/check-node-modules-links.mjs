import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const entryPath = fileURLToPath(import.meta.url);

// pnpm's isolated layout links packages instead of copying them. A tree that was
// materialised as plain directories (because the install ran with symlinks disabled,
// or because the tree was copied without preserving links) breaks module resolution
// without any warning: Node resolves the package from the top level and can no longer
// reach the platform specific optional packages that only exist inside the virtual
// store. The errors that surface point at unrelated packages, for example:
//
//   Error: Cannot find native binding. npm has a bug related to optional dependencies
//   Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: No "exports" main defined in .../estree-walker/package.json
//
// Detecting this early is cheaper than debugging the downstream symptoms.

const LINK_LEVELS = [
  { label: "node_modules", segments: ["node_modules"] },
  { label: "node_modules/.pnpm/node_modules", segments: ["node_modules", ".pnpm", "node_modules"] },
];

export function readNodeLinker(root) {
  const manifestPath = join(root, "node_modules", ".modules.yaml");
  let raw;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    return "unknown";
  }
  try {
    const manifest = JSON.parse(raw);
    if (typeof manifest.nodeLinker === "string") return manifest.nodeLinker;
    return "isolated";
  } catch {
    // .modules.yaml is JSON today; keep a plain scan as a fallback if that ever changes.
  }
  const match = raw.match(/"?nodeLinker"?\s*:\s*"?([a-z-]+)"?/);
  return match ? match[1] : "unknown";
}

export function collectPackageEntries(levelDirectory) {
  const entries = [];
  let children;
  try {
    children = readdirSync(levelDirectory, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const child of children) {
    if (child.name.startsWith(".")) continue;
    const childPath = join(levelDirectory, child.name);
    if (!child.name.startsWith("@")) {
      entries.push(childPath);
      continue;
    }
    let scoped;
    try {
      scoped = readdirSync(childPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const scopedChild of scoped) {
      if (scopedChild.name.startsWith(".")) continue;
      entries.push(join(childPath, scopedChild.name));
    }
  }
  return entries;
}

export function scanLinkTopology(root) {
  return LINK_LEVELS.map((level) => {
    const entries = collectPackageEntries(join(root, ...level.segments));
    const realDirectories = [];
    let links = 0;
    for (const entry of entries) {
      let stats;
      try {
        stats = lstatSync(entry);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) links += 1;
      else if (stats.isDirectory()) realDirectories.push(entry);
    }
    return { label: level.label, total: entries.length, links, realDirectories };
  });
}

export function formatFailure(root, levels) {
  const broken = levels.filter((level) => level.realDirectories.length > 0);
  const lines = [];
  lines.push("node_modules 链接拓扑损坏：pnpm 的 isolated 布局在下面这些位置应该是链接（junction/symlink），实际却是实体目录。");
  for (const level of broken) {
    lines.push("");
    lines.push(`  ${level.label}  (链接 ${level.links} 个，实体目录 ${level.realDirectories.length} 个)`);
    for (const entry of level.realDirectories.slice(0, 10)) {
      lines.push(`    - ${relative(root, entry)}`);
    }
    if (level.realDirectories.length > 10) lines.push(`    - ... 另外还有 ${level.realDirectories.length - 10} 个`);
  }
  lines.push("");
  lines.push("这种目录树会让模块解析失败，而报错文案通常与真实原因无关，例如：");
  lines.push('  Error: Cannot find native binding. npm has a bug related to optional dependencies');
  lines.push('  Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: No "exports" main defined in .../estree-walker/package.json');
  lines.push("");
  lines.push("修复方式：删除整棵 node_modules 后重装。pnpm 只会重建顶层的链接，不会修复已经存在的深层目录，");
  lines.push("所以增量执行 pnpm install 无法解决，必须整棵删除。");
  lines.push("");
  lines.push("  # PowerShell");
  lines.push("  Remove-Item -Recurse -Force node_modules");
  lines.push("  pnpm install --frozen-lockfile");
  return lines.join("\n");
}

export function main(args = process.argv.slice(2)) {
  const root = resolve(args[0] ?? process.cwd());
  const linker = readNodeLinker(root);
  if (linker === "unknown") {
    console.log("node_modules 尚未安装或缺少 .modules.yaml，跳过链接拓扑检查。");
    return 0;
  }
  if (linker !== "isolated") {
    console.log(`node-linker=${linker}，该布局不使用链接，跳过链接拓扑检查。`);
    return 0;
  }
  const levels = scanLinkTopology(root);
  const broken = levels.filter((level) => level.realDirectories.length > 0);
  if (broken.length > 0) {
    console.error(formatFailure(root, levels));
    return 1;
  }
  const summary = levels.map((level) => `${level.label}: ${level.links} 个链接`).join("，");
  console.log(`node_modules 链接拓扑正常（${summary}）。`);
  return 0;
}

if (process.argv[1] && realpathSync.native(process.argv[1]) === realpathSync.native(entryPath)) {
  process.exitCode = main();
}

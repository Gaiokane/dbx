#!/usr/bin/env node
// Reclaim disk space from rustc's incremental compilation caches.
//
// rustc writes one session directory per crate per compilation configuration
// into `target/<profile>/incremental/<crate>-<session-hash>/`. Cargo never
// garbage-collects them, so every feature-set or profile switch leaves another
// full copy behind forever. The abandoned sessions are dead weight: rustc will
// never read them again, and the compiled `.rlib` in `deps/` is what actually
// decides whether a crate needs rebuilding.
//
// This tool keeps the newest session per crate and removes the rest. It never
// touches `deps/`, `build/`, or the final binary, so a rebuild stays as fast as
// it was before the cleanup.
//
// Usage:
//   node scripts/clean-incremental.mjs            # dry run, changes nothing
//   node scripts/clean-incremental.mjs --apply    # actually delete
//   node scripts/clean-incremental.mjs --keep 2   # keep the 2 newest per crate
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

export const DEFAULT_KEEP = 1;
export const DEFAULT_MIN_AGE_MINUTES = 30;

export function parseArgs(argv) {
  const options = {
    apply: false,
    keep: DEFAULT_KEEP,
    minAgeMinutes: DEFAULT_MIN_AGE_MINUTES,
    targetDir: null,
    profiles: [],
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--apply":
        options.apply = true;
        break;
      case "--dry-run":
        options.apply = false;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--keep":
        options.keep = Number(argv[(index += 1)]);
        break;
      case "--min-age":
        options.minAgeMinutes = Number(argv[(index += 1)]);
        break;
      case "--target-dir":
        options.targetDir = argv[(index += 1)];
        break;
      case "--profile":
        options.profiles.push(argv[(index += 1)]);
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (!Number.isInteger(options.keep) || options.keep < 1) {
    throw new Error("--keep must be a positive integer");
  }
  if (!Number.isFinite(options.minAgeMinutes) || options.minAgeMinutes < 0) {
    throw new Error("--min-age must be a non-negative number of minutes");
  }
  if (options.targetDir !== null && !options.targetDir) {
    throw new Error("--target-dir requires a path");
  }
  for (const profile of options.profiles) {
    if (!profile) throw new Error("--profile requires a profile name");
  }

  return options;
}

export function resolveTargetDir({ explicit = null, env = {}, root = repoRoot } = {}) {
  if (explicit) return resolve(explicit);
  if (env.CARGO_TARGET_DIR) return resolve(env.CARGO_TARGET_DIR);
  return join(root, "target");
}

// rustc names a session directory `<crate>-<session-hash>`. Crate names are
// Rust identifiers, so the hash is always the last dash-separated segment.
export function splitSessionName(name) {
  const index = name.lastIndexOf("-");
  if (index <= 0) return { crate: name, session: "" };
  return { crate: name.slice(0, index), session: name.slice(index + 1) };
}

// Cargo lays the target directory out either as `target/<profile>/` or, for
// cross builds, as `target/<triple>/<profile>/`. Collect every directory that
// holds an `incremental` folder.
export function discoverIncrementalRoots(targetDir) {
  if (!existsSync(targetDir)) return [];
  const roots = [];

  for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(targetDir, entry.name);
    if (existsSync(join(candidate, "incremental"))) {
      roots.push({ profile: entry.name, root: join(candidate, "incremental") });
      continue;
    }
    for (const nested of readdirSync(candidate, { withFileTypes: true })) {
      if (!nested.isDirectory()) continue;
      const nestedPath = join(candidate, nested.name);
      if (existsSync(join(nestedPath, "incremental"))) {
        roots.push({ profile: `${entry.name}/${nested.name}`, root: join(nestedPath, "incremental") });
      }
    }
  }

  return roots.sort((left, right) => left.profile.localeCompare(right.profile));
}

// Walk a session directory once and collect both its size and the newest
// modification time anywhere inside it. The newest timestamp is what decides
// whether a session is still warm: a session rustc just wrote to is active.
export function measureSession(path) {
  let bytes = 0;
  let newestMtimeMs = 0;
  const stack = [path];

  while (stack.length > 0) {
    const current = stack.pop();
    let stat;
    try {
      stat = statSync(current);
    } catch {
      continue;
    }
    if (stat.mtimeMs > newestMtimeMs) newestMtimeMs = stat.mtimeMs;
    if (!stat.isDirectory()) {
      bytes += stat.size;
      continue;
    }

    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      stack.push(join(current, entry.name));
    }
  }

  return { bytes, newestMtimeMs };
}

export function collectSessions(incrementalRoot) {
  if (!existsSync(incrementalRoot)) return [];

  const sessions = [];
  for (const entry of readdirSync(incrementalRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(incrementalRoot, entry.name);
    const measured = measureSession(path);
    sessions.push({
      name: entry.name,
      crate: splitSessionName(entry.name).crate,
      path,
      bytes: measured.bytes,
      newestMtimeMs: measured.newestMtimeMs,
    });
  }

  return sessions;
}

// Decide what stays and what goes. A session survives when it is one of the
// `keep` newest sessions for its crate, or when it was written to recently
// enough that a build may still be using it.
export function classifySessions(sessions, { keep, minAgeMinutes, now = Date.now() }) {
  const protectedBefore = now - minAgeMinutes * 60_000;
  const byCrate = new Map();

  for (const session of sessions) {
    const list = byCrate.get(session.crate) ?? [];
    list.push(session);
    byCrate.set(session.crate, list);
  }

  const kept = [];
  const removable = [];
  const skipped = [];

  for (const [crate, list] of byCrate) {
    const sorted = [...list].sort((left, right) => right.newestMtimeMs - left.newestMtimeMs);
    sorted.forEach((session, index) => {
      if (index < keep) {
        kept.push(session);
        return;
      }
      if (session.newestMtimeMs >= protectedBefore) {
        skipped.push({ ...session, reason: "written to recently" });
        return;
      }
      removable.push(session);
    });
  }

  return { kept, removable, skipped, crateCount: byCrate.size };
}

export function removeSession(session) {
  rmSync(session.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 2)} ${units[unit]}`;
}

export function formatTable(rows) {
  if (rows.length === 0) return "";
  const header = Object.keys(rows[0]);
  const widths = header.map((column) => Math.max(column.length, ...rows.map((row) => String(row[column]).length)));
  const line = (cells) => cells.map((cell, index) => String(cell).padEnd(widths[index])).join("  ").trimEnd();
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map((row) => line(header.map((column) => row[column])))].join("\n");
}

function activeBuildWarning() {
  // A running `tauri dev` keeps cargo alive between rebuilds. Deleting a
  // session that is about to be reused is not fatal, but it is worth saying.
  try {
    if (process.platform === "win32") {
      const output = execFileSync("tasklist", ["/NH", "/FO", "CSV"], { encoding: "utf8", timeout: 5000 });
      const tools = new Set(
        output
          .split(/\r?\n/)
          .map((line) => line.split(",")[0]?.replace(/^"/, "").toLowerCase())
          .filter((name) => name === "cargo.exe" || name === "rustc.exe"),
      );
      return tools.size > 0 ? `detected a running build tool: ${[...tools].join(", ")}` : null;
    }
    const output = execFileSync("ps", ["-eo", "comm="], { encoding: "utf8", timeout: 5000 });
    const tools = new Set(
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((name) => name === "cargo" || name === "rustc"),
    );
    return tools.size > 0 ? `detected a running build tool: ${[...tools].join(", ")}` : null;
  } catch {
    return null;
  }
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`error: ${error.message}`);
    console.error("run with --help for usage");
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(
      [
        "Clean rustc incremental compilation sessions that cargo never reclaims.",
        "",
        "Usage: node scripts/clean-incremental.mjs [options]",
        "",
        "  --apply               actually delete (default is a dry run)",
        "  --keep <n>            keep the n newest sessions per crate (default 1)",
        "  --min-age <minutes>   protect sessions written to within n minutes (default 30)",
        "  --target-dir <path>   target directory (default: $CARGO_TARGET_DIR or ./target)",
        "  --profile <name>      only this profile, repeatable (default: every profile found)",
        "  -h, --help            show this help",
      ].join("\n"),
    );
    return;
  }

  const targetDir = resolveTargetDir({ explicit: options.targetDir, env: process.env });
  const roots = discoverIncrementalRoots(targetDir).filter(
    (entry) => options.profiles.length === 0 || options.profiles.includes(entry.profile),
  );

  console.log("DBX incremental cache cleanup");
  console.log(`  target dir : ${targetDir}`);
  console.log(`  keep       : ${options.keep} newest session(s) per crate`);
  console.log(`  protect    : sessions written to within the last ${options.minAgeMinutes} minutes`);
  console.log(`  mode       : ${options.apply ? "APPLY (will delete)" : "dry run (nothing is deleted)"}`);

  if (roots.length === 0) {
    console.log("\nNo incremental cache directory found. Nothing to clean.");
    return;
  }

  const warning = await activeBuildWarning();
  if (warning) {
    console.log(`\nNote: ${warning}. Sessions that are still warm are skipped automatically.`);
  }

  let totalFreed = 0;
  let totalRemoved = 0;
  let totalSkipped = 0;
  const failures = [];

  for (const { profile, root } of roots) {
    const sessions = collectSessions(root);
    if (sessions.length === 0) continue;

    const { kept, removable, skipped, crateCount } = classifySessions(sessions, {
      keep: options.keep,
      minAgeMinutes: options.minAgeMinutes,
    });

    const staleCrates = new Set(removable.map((session) => session.crate)).size;
    console.log(`\n[${profile}] ${sessions.length} sessions across ${crateCount} crates, ${staleCrates} with stale copies`);

    if (removable.length > 0) {
      const rows = [...removable]
        .sort((left, right) => right.bytes - left.bytes)
        .map((session) => ({
          crate: session.crate,
          session: session.name,
          size: formatBytes(session.bytes),
          age: formatAge(session.newestMtimeMs),
        }));
      console.log(formatTable(rows));
    }

    let freed = 0;
    let removed = 0;
    for (const session of removable) {
      if (!options.apply) {
        freed += session.bytes;
        removed += 1;
        continue;
      }
      try {
        removeSession(session);
        freed += session.bytes;
        removed += 1;
      } catch (error) {
        failures.push({ session: session.name, message: error.message });
      }
    }

    totalFreed += freed;
    totalRemoved += removed;
    totalSkipped += skipped.length;

    console.log(
      `  ${options.apply ? "removed" : "would remove"} ${removed} session(s), ${formatBytes(freed)} freed, ${skipped.length} skipped as too recent`,
    );
  }

  if (totalRemoved === 0 && totalSkipped === 0) {
    console.log("\nNothing to clean.");
    return;
  }

  console.log(
    `\n${options.apply ? "Removed" : "Would remove"} ${totalRemoved} session(s), freeing ${formatBytes(totalFreed)}.` +
      (totalSkipped > 0 ? ` ${totalSkipped} session(s) were skipped because they are still warm.` : ""),
  );

  if (!options.apply) {
    console.log("This was a dry run. Re-run with --apply to delete.");
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`failed to remove ${failure.session}: ${failure.message}`);
    }
    process.exitCode = 1;
  }
}

function formatAge(timestamp) {
  if (!timestamp) return "unknown";
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main(process.argv.slice(2));
}

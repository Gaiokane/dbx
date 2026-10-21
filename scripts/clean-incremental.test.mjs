import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_KEEP,
  DEFAULT_MIN_AGE_MINUTES,
  classifySessions,
  collectSessions,
  discoverIncrementalRoots,
  formatBytes,
  parseArgs,
  removeSession,
  resolveTargetDir,
  splitSessionName,
} from "./clean-incremental.mjs";

const MINUTE = 60_000;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dbx-incremental-"));
  return root;
}

// Create a session directory whose whole tree carries a known timestamp, so
// the "is this session still warm" rule can be exercised deterministically.
function writeSession(incrementalRoot, name, { ageMinutes = 0, bytes = 1024 } = {}) {
  const path = join(incrementalRoot, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "dep-graph"), Buffer.alloc(bytes, 1));
  const stamp = new Date(Date.now() - ageMinutes * MINUTE);
  utimesSync(path, stamp, stamp);
  utimesSync(join(path, "dep-graph"), stamp, stamp);
  return path;
}

test("parseArgs defaults to a dry run", () => {
  const options = parseArgs([]);
  assert.equal(options.apply, false);
  assert.equal(options.keep, DEFAULT_KEEP);
  assert.equal(options.minAgeMinutes, DEFAULT_MIN_AGE_MINUTES);
  assert.deepEqual(options.profiles, []);
});

test("parseArgs reads the cleanup switches", () => {
  const options = parseArgs(["--apply", "--keep", "3", "--min-age", "5", "--profile", "debug", "--profile", "release"]);
  assert.equal(options.apply, true);
  assert.equal(options.keep, 3);
  assert.equal(options.minAgeMinutes, 5);
  assert.deepEqual(options.profiles, ["debug", "release"]);
});

test("parseArgs rejects nonsense values", () => {
  assert.throws(() => parseArgs(["--keep", "0"]), /--keep/);
  assert.throws(() => parseArgs(["--keep", "many"]), /--keep/);
  assert.throws(() => parseArgs(["--min-age", "-1"]), /--min-age/);
  assert.throws(() => parseArgs(["--wat"]), /unknown argument/);
});

test("resolveTargetDir prefers the explicit path, then the env var, then the repo target", () => {
  assert.equal(resolveTargetDir({ explicit: "C:/cache/target", env: { CARGO_TARGET_DIR: "D:/other" } }), "C:\\cache\\target");
  assert.equal(resolveTargetDir({ env: { CARGO_TARGET_DIR: "D:/other" } }), "D:\\other");
  assert.equal(resolveTargetDir({ env: {}, root: "C:/repo" }), join("C:\\repo", "target"));
});

test("splitSessionName takes the crate name from the last dash", () => {
  assert.deepEqual(splitSessionName("dbx_lib-19djsfyiomcde"), { crate: "dbx_lib", session: "19djsfyiomcde" });
  assert.deepEqual(splitSessionName("dbx_sql_core-375huhgy0xtm2"), { crate: "dbx_sql_core", session: "375huhgy0xtm2" });
  assert.deepEqual(splitSessionName("noHash"), { crate: "noHash", session: "" });
});

test("discoverIncrementalRoots finds host and cross build layouts", () => {
  const root = fixture();
  try {
    mkdirSync(join(root, "debug", "incremental"), { recursive: true });
    mkdirSync(join(root, "x86_64-pc-windows-msvc", "release", "incremental"), { recursive: true });
    mkdirSync(join(root, "debug", "deps"), { recursive: true });

    const roots = discoverIncrementalRoots(root).map((entry) => entry.profile);
    assert.deepEqual(roots, ["debug", "x86_64-pc-windows-msvc/release"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("classifySessions keeps the newest session per crate and drops the rest", () => {
  const sessions = [
    { name: "dbx_lib-old", crate: "dbx_lib", bytes: 100, newestMtimeMs: 1000 },
    { name: "dbx_lib-new", crate: "dbx_lib", bytes: 200, newestMtimeMs: 3000 },
    { name: "dbx_core-only", crate: "dbx_core", bytes: 50, newestMtimeMs: 2000 },
  ];

  const result = classifySessions(sessions, { keep: 1, minAgeMinutes: 0, now: 4000 });

  assert.deepEqual(
    result.kept.map((session) => session.name).sort(),
    ["dbx_core-only", "dbx_lib-new"],
  );
  assert.deepEqual(
    result.removable.map((session) => session.name),
    ["dbx_lib-old"],
  );
  assert.equal(result.crateCount, 2);
});

test("classifySessions keeps extra sessions when keep is raised", () => {
  const sessions = [
    { name: "dbx_lib-a", crate: "dbx_lib", bytes: 1, newestMtimeMs: 1000 },
    { name: "dbx_lib-b", crate: "dbx_lib", bytes: 1, newestMtimeMs: 3000 },
    { name: "dbx_lib-c", crate: "dbx_lib", bytes: 1, newestMtimeMs: 2000 },
  ];

  const result = classifySessions(sessions, { keep: 2, minAgeMinutes: 0, now: 4000 });
  assert.equal(result.kept.length, 2);
  assert.equal(result.removable.length, 1);
  assert.equal(result.removable[0].name, "dbx_lib-a");
});

test("classifySessions protects sessions that were just written to", () => {
  const now = Date.now();
  const sessions = [
    { name: "dbx_lib-warmest", crate: "dbx_lib", bytes: 1, newestMtimeMs: now - 2 * MINUTE },
    { name: "dbx_lib-warm", crate: "dbx_lib", bytes: 1, newestMtimeMs: now - 10 * MINUTE },
  ];

  const result = classifySessions(sessions, { keep: 1, minAgeMinutes: 30, now });

  assert.deepEqual(
    result.kept.map((session) => session.name),
    ["dbx_lib-warmest"],
  );
  assert.equal(result.removable.length, 0);
  assert.deepEqual(
    result.skipped.map((session) => session.name),
    ["dbx_lib-warm"],
  );
  assert.equal(result.skipped[0].reason, "written to recently");
});

test("classifySessions removes copies that are older than the protection window", () => {
  const now = Date.now();
  const sessions = [
    { name: "dbx_lib-warm", crate: "dbx_lib", bytes: 1, newestMtimeMs: now - 2 * MINUTE },
    { name: "dbx_lib-cold", crate: "dbx_lib", bytes: 1, newestMtimeMs: now - 120 * MINUTE },
  ];

  const result = classifySessions(sessions, { keep: 1, minAgeMinutes: 30, now });

  assert.deepEqual(
    result.kept.map((session) => session.name),
    ["dbx_lib-warm"],
  );
  assert.deepEqual(
    result.removable.map((session) => session.name),
    ["dbx_lib-cold"],
  );
  assert.equal(result.skipped.length, 0);
});

test("collectSessions measures the size and the newest write time of a session", () => {
  const root = fixture();
  try {
    const incremental = join(root, "incremental");
    mkdirSync(incremental, { recursive: true });
    writeSession(incremental, "dbx_lib-abc123", { ageMinutes: 90, bytes: 4096 });

    const sessions = collectSessions(incremental);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].crate, "dbx_lib");
    assert.equal(sessions[0].bytes, 4096);
    assert.ok(sessions[0].newestMtimeMs <= Date.now() - 80 * MINUTE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removeSession deletes the whole session directory", () => {
  const root = fixture();
  try {
    const incremental = join(root, "incremental");
    mkdirSync(incremental, { recursive: true });
    const path = writeSession(incremental, "dbx_lib-abc123");

    removeSession({ path });

    assert.throws(() => statSync(path));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("end to end: stale sessions go, the newest one stays", () => {
  const root = fixture();
  try {
    const incremental = join(root, "incremental");
    mkdirSync(incremental, { recursive: true });
    writeSession(incremental, "dbx_lib-old1", { ageMinutes: 240, bytes: 2048 });
    writeSession(incremental, "dbx_lib-old2", { ageMinutes: 120, bytes: 2048 });
    writeSession(incremental, "dbx_lib-live", { ageMinutes: 5, bytes: 2048 });
    writeSession(incremental, "dbx_core-live", { ageMinutes: 5, bytes: 1024 });

    const sessions = collectSessions(incremental);
    const result = classifySessions(sessions, { keep: 1, minAgeMinutes: 30 });

    assert.deepEqual(
      result.kept.map((session) => session.name).sort(),
      ["dbx_core-live", "dbx_lib-live"],
    );
    assert.deepEqual(
      result.removable.map((session) => session.name).sort(),
      ["dbx_lib-old1", "dbx_lib-old2"],
    );

    for (const session of result.removable) removeSession(session);

    const remaining = collectSessions(incremental)
      .map((session) => session.name)
      .sort();
    assert.deepEqual(remaining, ["dbx_core-live", "dbx_lib-live"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("formatBytes renders human readable sizes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(15 * 1024 * 1024), "15.00 MB");
  assert.equal(formatBytes(14 * 1024 ** 3), "14.00 GB");
  assert.equal(formatBytes(204 * 1024 * 1024 * 1024), "204 GB");
});

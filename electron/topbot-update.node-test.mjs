import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile, readFile, copyFile, readdir, rm, stat, rename, symlink, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { checkManifest, findRelease, resourcePreflight, trustedFetch } from "./topbot-release.mjs";
import { healthTicketPath, startUpdateHealth } from "./topbot-update-health.mjs";
import { createManagedUpdater, writeUpdateHandoff } from "./topbot-managed-update.mjs";

const run = promisify(execFile);
const windows = process.platform === "win32";
// Windows hosted runners may expose TEMP through its 8.3 alias.
const temp = await realpath(os.tmpdir());
const ps = "pwsh.exe";
const runner = fileURLToPath(new URL("./topbot-update-runner.ps1", import.meta.url));
const maker = fileURLToPath(new URL("./fixtures/topbot-update-fixture.ps1", import.meta.url));
const version = "0.1.161-topbot.5";
const manifest = () => ({ schema: 1, repository: "topway-ai/TopBot-Iteration-Lab", platform: "win32-x64", version, dataEpoch: 1,
  sha256: "a".repeat(64), bytes: 100, unpackedBytes: 200, url: `https://github.com/topway-ai/TopBot-Iteration-Lab/releases/download/v${version}/TopBot-${version}-x64.zip` });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = file => readFile(file, "utf8").then(JSON.parse);
const command = (file, args, options = {}) => run(ps, ["-NoProfile", "-NonInteractive", "-File", file, ...args], { windowsHide: true, timeout: 90000, ...options });

test("managed updates serialize checks and do not quit when busy or the helper fails", async t => {
  const root = await mkdtemp(path.join(temp, "topbot-managed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let finds = 0, freezes = 0, thaws = 0, quits = 0, busy = false, failHelper = false;
  const states = [];
  const updater = createManagedUpdater({ version: "0.1.161-topbot.4", root, installDir: path.join(root, "TopBot"), dataDirs: [path.join(root, "data")],
    setState: state => states.push(state), signals: { busy: () => busy, work: async () => null }, preflight: async () => {},
    freeze: async () => freezes++, thaw: async () => thaws++, quit: () => quits++,
    find: async () => { finds++; await pause(10); return manifest(); }, download: async () => {},
    helper: (_job, mode) => { if (mode === "Prepare") return Promise.resolve(); if (failHelper) throw new Error("helper launch failed"); },
  });
  const first = updater.check(true), second = updater.check(true);
  assert.equal(first, second); await first; assert.equal(finds, 1); assert.equal(updater.installable().version, version);
  busy = true; await updater.install(); assert.equal(freezes, 0); assert.equal(quits, 0);
  busy = false; failHelper = true; await updater.install();
  assert.equal(freezes, 1); assert.equal(thaws, 1); assert.equal(quits, 0);
  assert.equal(states.at(-1).status, "error");
});

test("update protocol pins source, identity, compatibility and resource bounds", async () => {
  assert.equal(checkManifest(manifest(), { current: "0.1.161-topbot.4" }).version, version);
  assert.equal(checkManifest(manifest(), { current: version }), null);
  for (const patch of [{ repository: "evil/repo" }, { dataEpoch: 2 }, { sha256: "no" }, { bytes: 9e9 }, { unpackedBytes: 9e9 },
    { version: "../evil" }, { url: "https://github.com/other/repo/x.zip" }, { url: manifest().url + "?redirect=evil" }]) {
    assert.throws(() => checkManifest({ ...manifest(), ...patch }));
  }
  await assert.rejects(resourcePreflight(".", 0, { freeRAM: () => 1024 }), /RAM/);
  await assert.rejects(resourcePreflight(".", 100, { freeRAM: () => 4 * 1024 ** 3, disk: async () => ({ bavail: 1, bsize: 1 }) }), /disk/);
  await assert.rejects(trustedFetch("https://github.com/example", { fetchImpl: async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }) }), /Untrusted/);
});

test("release selection rejects drafts and never uses a foreign manifest", async () => {
  const latest = manifest();
  const manifestUrl = `https://github.com/topway-ai/TopBot-Iteration-Lab/releases/download/v${version}/topbot-windows-update.json`;
  const release = { tag_name: `v${version}`, draft: false, prerelease: false, immutable: true,
    assets: [{ name: "topbot-windows-update.json", browser_download_url: manifestUrl }] };
  let calls = 0;
  const fetchImpl = async url => { calls++; return Response.json(url.includes("api.github") ? [release] : latest); };
  assert.equal((await findRelease({ current: "0.1.161-topbot.4", fetchImpl })).version, version);
  assert.equal(calls, 2);
  release.draft = true;
  assert.equal(await findRelease({ current: "0.1.161-topbot.4", fetchImpl }), null);
  release.draft = false;
  for (const immutable of [false, undefined]) {
    release.immutable = immutable;
    const before = calls;
    assert.equal(await findRelease({ current: "0.1.161-topbot.4", fetchImpl }), null);
    assert.equal(calls - before, 1);
  }
  release.immutable = true; release.assets[0].browser_download_url = "https://evil.test/manifest";
  await assert.rejects(findRelease({ current: "0.1.161-topbot.4", fetchImpl }), /Unexpected/);
});

test("handoff retries transient receipt locks while exposing only complete JSON", async t => {
  const job = await mkdtemp(path.join(temp, "topbot-handoff-"));
  t.after(() => rm(job, { recursive: true, force: true }));
  const file = path.join(job, "go.json"), record = { token: "a".repeat(64), pid: 42 };
  let attempts = 0;
  const waits = [];
  await writeUpdateHandoff(job, record, { replace: async (from, to) => {
    assert.equal(to, file);
    assert.deepEqual(await json(from), record);
    await assert.rejects(stat(to), { code: "ENOENT" });
    if (++attempts <= 2) throw Object.assign(new Error("locked"), { code: "EBUSY" });
    await rename(from, to);
  }, wait: async ms => { waits.push(ms); } });
  assert.deepEqual(waits, [50, 100]);
  assert.deepEqual(await json(file), record);
  await assert.rejects(writeUpdateHandoff(job, { ...record, pid: 43 }, {
    replace: async () => { throw Object.assign(new Error("full disk"), { code: "ENOSPC" }); },
    wait: async () => assert.fail("Permanent errors must not be retried."),
  }), { code: "ENOSPC" });
  assert.deepEqual(await readdir(job), ["go.json"]);
  assert.deepEqual(await json(file), record);
});

test("health receipts require an owned ticket and matching executable", async t => {
  const root = await mkdtemp(path.join(temp, "topbot-health-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const job = path.join(root, "transactions", "test"); await mkdir(job, { recursive: true });
  const file = path.join(job, "ticket.json"), token = "a".repeat(64), installDir = path.join(root, "app");
  const argv = [`--topbot-update-ticket=${file}`];
  assert.equal(healthTicketPath(["--topbot-update-ticket=/outside/ticket.json"], root), null);
  await writeFile(file, JSON.stringify({ token, version, dataEpoch: 1, installDir }));
  await assert.rejects(startUpdateHealth({ argv, root, version, executable: "/wrong/app", ready: async () => true, quit() {} }), /match/);
  let quits = 0;
  const close = await startUpdateHealth({ argv, root, version, executable: path.join(installDir, "TopBot.exe"), ready: async () => true, quit: () => quits++, intervalMs: 20 });
  t.after(close);
  assert.equal((await json(path.join(job, "health.json"))).ready, true);
  await writeFile(path.join(job, "stop.json"), JSON.stringify({ token: "wrong" }));
  await pause(60); assert.equal(quits, 0);
  await writeFile(path.join(job, "stop.json"), JSON.stringify({ token }));
  await pause(60); assert.ok(quits > 0);
  close();
});

test("Windows independent helper: upgrade, snapshot, rollback and injected failures", { skip: !windows, timeout: 240000 }, async t => {
  const base = await mkdtemp(path.join(temp, "topbot-updater-test-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }));
  const binary = path.join(base, "fixture.exe");
  await command(maker, ["-Mode", "Compile", "-Destination", binary]);
  async function fixture(name, appMode = "healthy", traversal = false) {
    const home = path.join(base, name), root = path.join(home, "updates"), job = path.join(root, "transactions", "test");
    const install = path.join(home, "Programs", "TopBot"), source = path.join(home, "package"), data = path.join(home, "data");
    for (const dir of [job, install, path.join(source, "resources"), data]) await mkdir(dir, { recursive: true });
    await copyFile(binary, path.join(install, "TopBot.exe")); await writeFile(path.join(install, "old.txt"), "old program");
    await writeFile(path.join(data, "chats.json"), "original chat");
    await copyFile(binary, path.join(source, "TopBot.exe")); await writeFile(path.join(source, "fixture-mode.txt"), appMode);
    await writeFile(path.join(source, "resources", "app.asar"), "fixture asar");
    await writeFile(path.join(source, "resources", "topbot-build.json"), JSON.stringify({ version, dataEpoch: 1, repository: "topway-ai/TopBot-Iteration-Lab" }));
    const archive = path.join(job, "update.zip");
    await command(maker, ["-Mode", traversal ? "Traversal" : "Zip", "-Source", source, "-Destination", archive]);
    const bytes = await readFile(archive);
    const plan = { ...manifest(), installDir: install, profileDir: data, dataDirs: [data], previousVersion: "0.1.161-topbot.4", token: randomBytes(32).toString("hex"),
      bytes: bytes.length, unpackedBytes: 2 * 1024 * 1024, sha256: createHash("sha256").update(bytes).digest("hex") };
    await writeFile(path.join(job, "plan.json"), JSON.stringify(plan)); await copyFile(runner, path.join(job, "runner.ps1"));
    await copyFile(fileURLToPath(new URL("./topbot-update-launch.ps1", import.meta.url)), path.join(job, "launch.ps1"));
    return { root, job, install, data, archive, plan };
  }
  async function helper(f, mode, handoff = false) {
    const child = spawn(ps, ["-NoProfile", "-NonInteractive", "-File", path.join(f.job, "runner.ps1"), "-Mode", mode,
      "-PlanPath", path.join(f.job, "plan.json"), "-NoRecoveryRegistration", "-ProbeSeconds", "1", "-TimeoutSeconds", "6"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", c => output += c); child.stderr.on("data", c => output += c);
    const completed = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve({ code, output })); });
    if (handoff) {
      for (let i = 0; i < 100; i++) {
        const receipt = await json(path.join(f.job, "helper-ready.json")).catch(() => null);
        if (receipt?.pid === child.pid) { await writeUpdateHandoff(f.job, { token: f.plan.token, pid: child.pid }); break; }
        if (child.exitCode !== null) break;
        await pause(100);
      }
    }
    return completed;
  }
  await t.test("the real helper survives the parent process exiting after handoff", async () => {
    const f = await fixture("parent-exit");
    const runtime = (await run("where.exe", [ps], { windowsHide: true })).stdout.trim().split(/\r?\n/)[0];
    await writeFile(path.join(f.root, "runtime.json"), JSON.stringify({ powershell: runtime }));
    const prepared = await helper(f, "Prepare"); assert.equal(prepared.code, 0, prepared.output);
    const parent = fileURLToPath(new URL("./fixtures/topbot-update-lifetime.mjs", import.meta.url));
    await run(process.execPath, [parent, f.job], { windowsHide: true, timeout: 15000 });
    let state;
    for (let i = 0; i < 450; i++) {
      state = await json(path.join(f.job, "state.json"));
      if (["committed", "failed", "recovery-needed", "rolled-back"].includes(state.phase)) break;
      await pause(100);
    }
    assert.equal(state.phase, "committed", JSON.stringify(state));
    await writeFile(path.join(f.job, "stop.json"), JSON.stringify({ token: f.plan.token }));
    await pause(500);
  });
  await t.test("a briefly locked heartbeat still allows a healthy upgrade and rollback preserves newer data", async () => {
    const f = await fixture("happy", "busy-health");
    let result = await helper(f, "Prepare"); assert.equal(result.code, 0, result.output);
    result = await helper(f, "Apply", true); assert.equal(result.code, 0, result.output);
    assert.equal((await json(path.join(f.job, "state.json"))).phase, "committed");
    assert.equal(await readFile(path.join(f.job, "previous", "old.txt"), "utf8"), "old program");
    assert.equal(await readFile(path.join(f.job, "data-snapshot", "0", "chats.json"), "utf8"), "original chat");
    await writeFile(path.join(f.data, "chats.json"), "newer chat after update");
    await writeFile(path.join(f.job, "stop.json"), JSON.stringify({ token: f.plan.token })); await pause(1000);
    result = await helper(f, "Rollback", true); assert.equal(result.code, 0, result.output);
    assert.equal((await json(path.join(f.job, "state.json"))).phase, "rolled-back");
    assert.equal(await readFile(path.join(f.install, "old.txt"), "utf8"), "old program");
    assert.equal(await readFile(path.join(f.data, "chats.json"), "utf8"), "newer chat after update");
    assert.deepEqual(await json(path.join(f.root, "blocked.json")), [version]);
  });
  for (const mode of ["crash", "unhealthy", "unresponsive"]) await t.test(`automatic rollback on ${mode}`, async () => {
    const f = await fixture(mode, mode);
    let result = await helper(f, "Prepare"); assert.equal(result.code, 0, result.output);
    result = await helper(f, "Apply", true); assert.equal(result.code, 1, result.output);
    assert.equal((await json(path.join(f.job, "state.json"))).phase, "rolled-back");
    assert.equal(await readFile(path.join(f.install, "old.txt"), "utf8"), "old program");
    assert.equal(await readFile(path.join(f.data, "chats.json"), "utf8"), "original chat");
  });
  await t.test("bad digest leaves old program and data untouched", async () => {
    const f = await fixture("digest"); await writeFile(f.archive, "bad download");
    const result = await helper(f, "Prepare"); assert.equal(result.code, 1);
    assert.match(result.output, /integrity/); assert.equal(await readFile(path.join(f.install, "old.txt"), "utf8"), "old program");
  });
  await t.test("archive traversal is rejected before extraction", async () => {
    const f = await fixture("traversal", "healthy", true);
    const result = await helper(f, "Prepare"); assert.equal(result.code, 1);
    assert.match(result.output, /Unsafe/); await assert.rejects(stat(path.join(f.job, "outside.txt")), { code: "ENOENT" });
  });
  await t.test("interrupted program switch recovers from its durable journal", async () => {
    const f = await fixture("interruption");
    let result = await helper(f, "Prepare"); assert.equal(result.code, 0, result.output);
    await rename(f.install, path.join(f.job, "previous"));
    await writeFile(path.join(f.job, "state.json"), JSON.stringify({ phase: "switching" }));
    result = await helper(f, "Recover"); assert.equal(result.code, 0, result.output);
    assert.equal((await json(path.join(f.job, "state.json"))).phase, "rolled-back");
    assert.equal(await readFile(path.join(f.install, "old.txt"), "utf8"), "old program");
  });
  await t.test("snapshot links abort before the old program is moved", async () => {
    const f = await fixture("snapshot-failure");
    let result = await helper(f, "Prepare"); assert.equal(result.code, 0, result.output);
    await symlink(f.install, path.join(f.data, "linked"), "junction");
    result = await helper(f, "Apply", true); assert.equal(result.code, 1);
    assert.match(result.output, /snapshot contains a link/);
    assert.equal(await readFile(path.join(f.install, "old.txt"), "utf8"), "old program");
    await assert.rejects(stat(path.join(f.job, "previous")), { code: "ENOENT" });
  });
  await t.test("internal skill junctions are recorded without following or duplicating them", async () => {
    const f = await fixture("internal-link");
    const target = path.join(f.data, "skills", "example");
    await mkdir(target, { recursive: true }); await writeFile(path.join(target, "SKILL.md"), "skill data");
    await symlink(target, path.join(f.data, "skill-alias"), "junction");
    let result = await helper(f, "Prepare"); assert.equal(result.code, 0, result.output);
    result = await helper(f, "Apply", true); assert.equal(result.code, 0, result.output);
    const snapshot = path.join(f.job, "data-snapshot");
    const metadata = await json(path.join(snapshot, "snapshot.json"));
    assert.deepEqual(metadata.links, [{ sourceIndex: 0, path: "skill-alias", target: "skills\\example", type: "junction" }]);
    assert.equal(await readFile(path.join(snapshot, "0", "skills", "example", "SKILL.md"), "utf8"), "skill data");
    await assert.rejects(stat(path.join(snapshot, "0", "skill-alias")), { code: "ENOENT" });
    await writeFile(path.join(f.job, "stop.json"), JSON.stringify({ token: f.plan.token })); await pause(500);
  });
  await t.test("out-of-bound install target is refused", async () => {
    const f = await fixture("target"); f.plan.installDir = path.dirname(f.install);
    await writeFile(path.join(f.job, "plan.json"), JSON.stringify(f.plan));
    const result = await helper(f, "Prepare"); assert.equal(result.code, 1); assert.match(result.output, /Invalid.*target/);
  });
});

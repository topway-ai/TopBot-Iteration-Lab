import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { checkManifest, MANIFEST_NAME } from "../electron/topbot-release.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packaged = path.resolve(process.argv[2] || path.join(root, "release", "win-unpacked"));
const previous = path.resolve(process.argv[3] || packaged);
const archiveOnly = process.argv.includes("--qualified-archive-only");
assert.ok(!archiveOnly || previous !== packaged, "An archive-only test needs a separate previous installation.");
const releaseDirectory = archiveOnly ? packaged : path.dirname(packaged);
const releaseManifest = archiveOnly || process.argv.includes("--release-archive")
  ? checkManifest(JSON.parse(await readFile(path.join(releaseDirectory, MANIFEST_NAME), "utf8"))) : null;
const build = archiveOnly ? releaseManifest : JSON.parse(await readFile(path.join(packaged, "resources", "topbot-build.json"), "utf8"));
const builder = createRequire(import.meta.resolve("electron-builder"));
const asar = createRequire(builder.resolve("app-builder-lib"))("@electron/asar");
const previousVersion = JSON.parse(asar.extractFile(path.join(previous, "resources", "app.asar"), "package.json").toString()).version;
const scratch = path.resolve(process.env.TOPBOT_LOCAL_BUILD_SCRATCH || path.join(root, ".omb-scratch"));
await mkdir(scratch, { recursive: true });
const base = await mkdtemp(path.join(scratch, "update-package-"));
const updates = process.argv.includes("--register-recovery")
  ? await mkdtemp(path.join(os.homedir(), ".topbot-update-test-")) : path.join(base, "updates");
const job = path.join(updates, "transactions", "qualification");
const installDir = path.join(base, "Programs", "TopBot"), home = path.join(base, "home");
const data = path.join(home, "data"), profile = path.join(home, "profile");
const ps = (await promisify(execFile)("where.exe", ["pwsh.exe"], { windowsHide: true })).stdout.trim().split(/\r?\n/)[0];
const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: path.dirname(ps) + ";" + path.join(process.env.SystemRoot, "System32"),
  HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
  TEMP: base, TMP: base, OMB_DATA_DIR: data, TOPBOT_UPDATE_ROOT: updates };
for (const directory of [job, data, profile, env.APPDATA, env.LOCALAPPDATA]) await mkdir(directory, { recursive: true });
await writeFile(path.join(data, "qualification.txt"), "Disposable update fixture. No real account or key.\n");
console.log(JSON.stringify({ base, installDir, packaged, updates }));
await cp(previous, installDir, { recursive: true, dereference: false });
await cp(path.join(root, "electron", "topbot-update-runner.ps1"), path.join(job, "runner.ps1"));
const zip = path.join(job, "update.zip");
if (releaseManifest) {
  assert.equal(releaseManifest.version, build.version);
  await cp(path.join(releaseDirectory, `TopBot-${releaseManifest.version}-x64.zip`), zip);
} else {
  await promisify(execFile)(ps, ["-NoProfile", "-NonInteractive", "-File", path.join(root, "electron", "fixtures", "topbot-update-fixture.ps1"),
    "-Mode", "ZipFast", "-Source", packaged, "-Destination", zip], { windowsHide: true, timeout: 240000 });
}
const digest = createHash("sha256");
for await (const chunk of createReadStream(zip)) digest.update(chunk);
const size = (await stat(zip)).size;
const sha256 = digest.digest("hex");
if (releaseManifest) {
  assert.equal(size, releaseManifest.bytes);
  assert.equal(sha256, releaseManifest.sha256);
}
const plan = { schema: 1, version: build.version, previousVersion, dataEpoch: 1,
  bytes: size, unpackedBytes: releaseManifest?.unpackedBytes ?? size + 16 * 1024 ** 2, sha256, installDir, profileDir: profile,
  dataDirs: [data, profile], token: randomBytes(32).toString("hex") };
await writeFile(path.join(job, "plan.json"), JSON.stringify(plan));
const json = file => readFile(file, "utf8").then(JSON.parse);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { base, updates, version: build.version, archiveBytes: size, started: new Date().toISOString(), checks: [] };
const injectFailure = process.argv.includes("--inject-health-timeout");
async function run(mode) {
  const started = Date.now();
  const failApply = injectFailure && mode === "Apply";
  const child = spawn(ps, ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-File", path.join(job, "runner.ps1"),
    "-Mode", mode, "-PlanPath", path.join(job, "plan.json"), ...(failApply ? ["-ProbeSeconds", "120", "-TimeoutSeconds", "20"] : []),
    ...(process.argv.includes("--register-recovery") ? [] : ["-NoRecoveryRegistration"])], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output = (output + chunk).slice(-8000); });
  child.stderr.on("data", chunk => { output = (output + chunk).slice(-8000); });
  const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code)); });
  if (mode === "Apply" || mode === "Rollback") {
    for (let i = 0; i < 150; i++) {
      const receipt = await json(path.join(job, "helper-ready.json")).catch(() => null);
      if (receipt?.pid === child.pid && receipt.token === plan.token) {
        await writeFile(path.join(job, "go.json"), JSON.stringify({ token: plan.token, pid: child.pid }));
        if (mode === "Rollback") await writeFile(path.join(job, "stop.json"), JSON.stringify({ token: plan.token }));
        break;
      }
      if (child.exitCode !== null) break;
      await pause(100);
    }
  }
  const code = await done;
  const state = await json(path.join(job, "state.json")).catch(() => null);
  const result = { mode, code, seconds: (Date.now() - started) / 1000, state, output };
  report.checks.push(result); console.log(JSON.stringify(result));
  assert.equal(code, failApply ? 1 : 0, output);
  if (failApply) assert.match(output, /sustained desktop and server health check/);
  return state;
}
try {
  assert.equal((await run("Prepare")).phase, "prepared");
  if (process.argv.includes("--hidden-candidate")) {
    await writeFile(path.join(profile, "update-when-quiet.json"), JSON.stringify({ v: 1, from: previousVersion, to: build.version,
      tries: 1, at: Date.now(), window: false }));
  }
  assert.equal((await run("Apply")).phase, injectFailure ? "rolled-back" : "committed");
  assert.equal(await readFile(path.join(data, "qualification.txt"), "utf8"), "Disposable update fixture. No real account or key.\n");
  const restoredVersion = () => JSON.parse(asar.extractFile(path.join(installDir, "resources", "app.asar"), "package.json").toString()).version;
  if (injectFailure) {
    assert.equal(restoredVersion(), previousVersion);
    assert.ok((await json(path.join(updates, "blocked.json"))).includes(build.version));
    report.automaticRollback = { version: previousVersion, retainedFixtureData: true, blockedCandidate: build.version };
  } else {
    const health = await json(path.join(job, "health.json"));
    assert.equal(health.ready, true); assert.equal(health.version, build.version);
    assert.ok((await stat(path.join(job, "previous", "TopBot.exe"))).isFile());
    report.health = { ...health, token: "[omitted]" };
  }
  if (!injectFailure && process.argv.includes("--rollback-check")) {
    const sentinel = path.join(data, "after-upgrade.txt");
    await writeFile(sentinel, "The user's data must survive program rollback.\n");
    assert.equal((await run("Rollback")).phase, "rolled-back");
    assert.equal(await readFile(sentinel, "utf8"), "The user's data must survive program rollback.\n");
    assert.equal(restoredVersion(), previousVersion);
    report.rollback = { version: previousVersion, retainedNewData: true };
  }
  report.passed = true;
} finally {
  await writeFile(path.join(job, "stop.json"), JSON.stringify({ token: plan.token }));
  await pause(5000);
  assert.ok(installDir.startsWith(scratch + path.sep));
  const expression = `$p = '${installDir.replaceAll("'", "''")}\\'; $left = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($p, [StringComparison]::OrdinalIgnoreCase) }); $left | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; $left.Count`;
  const cleanup = await promisify(execFile)(ps, ["-NoProfile", "-NonInteractive", "-Command", expression], { windowsHide: true });
  report.fixtureProcessesForcedClosed = Number(cleanup.stdout.trim());
  report.ended = new Date().toISOString();
  const evidence = path.join(scratch, injectFailure ? "topbot-update-failure-rollback-result.json" : "topbot-update-package-result.json");
  await writeFile(evidence, JSON.stringify(report, null, 2));
  console.log(`Evidence: ${evidence}`);
}

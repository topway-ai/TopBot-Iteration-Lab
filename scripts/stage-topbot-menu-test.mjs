// Stage a qualified archive for an operator-driven menu test without using the live profile or release feed.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { cp, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createManagedUpdater, runUpdateHelper, updatePowerShell, updateRoot } from "../electron/topbot-managed-update.mjs";
import { checkManifest, resourcePreflight } from "../electron/topbot-release.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(repo, ".omb-scratch");
const json = async file => JSON.parse(await readFile(file, "utf8"));
const evidence = await json(path.join(scratch, "topbot-update-package-result.json"));
assert.equal(evidence.passed, true);
const archiveJob = path.join(evidence.updates, "transactions", "qualification");
const qualified = await json(path.join(archiveJob, "plan.json"));
assert.equal(qualified.version, evidence.version);
const current = qualified.version.replace(/-topbot\.\d+$/, "-topbot.0");
const manifest = checkManifest({ ...qualified, repository: "topway-ai/TopBot-Iteration-Lab", platform: "win32-x64",
  url: `https://github.com/topway-ai/TopBot-Iteration-Lab/releases/download/v${qualified.version}/TopBot-${qualified.version}-x64.zip` }, { current });
assert.ok(manifest);
const runtime = updatePowerShell(updateRoot());
await resourcePreflight(os.homedir(), 5 * 1024 ** 3);
const base = await mkdtemp(path.join(os.homedir(), ".topbot-menu-test-"));
const root = path.join(base, "updates"), home = path.join(base, "home"), installDir = path.join(base, "Programs", "TopBot");
const profileDir = path.join(home, "profile"), data = path.join(home, "data");
const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
  PATH: path.dirname(runtime) + ";" + path.join(process.env.SystemRoot, "System32"),
  HOME: home, USERPROFILE: home, APPDATA: path.join(home, "Roaming"), LOCALAPPDATA: path.join(home, "Local"),
  TMP: base, TEMP: base, OMB_DATA_DIR: data, TOPBOT_UPDATE_ROOT: root };
for (const dir of [root, profileDir, data, env.APPDATA, env.LOCALAPPDATA]) await mkdir(dir, { recursive: true });
await writeFile(path.join(root, "runtime.json"), JSON.stringify({ powershell: runtime }));
await writeFile(path.join(data, "before-update.txt"), "fixture only\n");
// A completed rollback can leave the qualification installation on the older version.
const packaged = await json(path.join(scratch, "topbot-local-build.json"));
assert.equal(packaged.version, manifest.version);
assert.equal(path.dirname(path.dirname(path.resolve(packaged.app))), scratch);
assert.equal(path.basename(packaged.app), "TopBot");
await cp(packaged.app, installDir, { recursive: true, dereference: false });
const builder = createRequire(import.meta.resolve("electron-builder"));
const asar = createRequire(builder.resolve("app-builder-lib"))("@electron/asar");
const archive = path.join(installDir, "resources", "app.asar"), source = path.join(base, "asar");
asar.extractAll(archive, source);
const pkg = path.join(source, "package.json"), marker = path.join(installDir, "resources", "topbot-build.json");
assert.equal((await json(pkg)).version, manifest.version);
for (const file of [pkg, marker]) await writeFile(file, JSON.stringify({ ...await json(file), version: current }));
await asar.createPackage(source, archive);
let job, failure;
const updater = createManagedUpdater({ version: current, installDir, profileDir, dataDirs: [data, profileDir], root,
  setState: s => { if (s.status === "error") failure = s.message; }, signals: { busy: () => false, work: async () => null },
  find: async () => manifest, download: (_m, file) => copyFile(path.join(archiveJob, "update.zip"), file),
  helper: (dir, mode, options) => { job = dir; return runUpdateHelper(dir, mode, options); } });
await updater.check(true);
assert.equal(failure, undefined);
assert.equal(updater.installable()?.version, manifest.version);
const evidenceFile = path.join(scratch, "topbot-menu-test.json");
await writeFile(evidenceFile, JSON.stringify({ base, job, data, profileDir, installDir, current, target: manifest.version }, null, 2));
const quote = s => "'" + s.replaceAll("'", "''") + "'";
await promisify(execFile)(runtime, ["-NoProfile", "-NonInteractive", "-Command",
  `Start-Process -FilePath ${quote(path.join(installDir, "TopBot.exe"))} -WorkingDirectory ${quote(installDir)} -ArgumentList ${quote('--user-data-dir="' + profileDir + '"')}`], { env, windowsHide: true });
console.log(JSON.stringify({ evidenceFile, base, job, staged: manifest.version }));

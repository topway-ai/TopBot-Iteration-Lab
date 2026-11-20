import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createManagedUpdater, runUpdateHelper, updateRoot } from "../electron/topbot-managed-update.mjs";
import { checkManifest, readUpdateJson } from "../electron/topbot-release.mjs";

assert.equal(process.platform, "win32");
assert.ok(process.argv[2], "Pass the successful real-package qualification report.");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidence = JSON.parse(await readFile(path.resolve(process.argv[2]), "utf8"));
assert.equal(evidence.passed, true, "The packaged application must pass qualification first.");
const qualifiedJob = path.join(evidence.updates, "transactions", "qualification");
const qualified = await readUpdateJson(path.join(qualifiedJob, "plan.json"));
assert.equal((await readUpdateJson(path.join(qualifiedJob, "state.json"))).phase, "committed");
const installDir = path.join(process.env.LOCALAPPDATA, "Programs", "TopBot");
const profileDir = path.join(process.env.APPDATA, "openmausbot");
const builder = createRequire(import.meta.resolve("electron-builder"));
const asar = createRequire(builder.resolve("app-builder-lib"))("@electron/asar");
const current = JSON.parse(asar.extractFile(path.join(installDir, "resources", "app.asar"), "package.json").toString());
assert.equal(current.version, qualified.previousVersion, "The live version changed after qualification.");
assert.equal(evidence.version, qualified.version);
const manifest = checkManifest({ ...qualified, repository: "topway-ai/TopBot-Iteration-Lab", platform: "win32-x64",
  url: `https://github.com/topway-ai/TopBot-Iteration-Lab/releases/download/v${qualified.version}/TopBot-${qualified.version}-x64.zip` }, { current: current.version });
assert.ok(manifest, "Only a newer qualified build may be installed.");
const root = updateRoot();
await mkdir(root, { recursive: true });
const command = promisify(execFile);
const ps = (await command("where.exe", ["pwsh.exe"], { windowsHide: true })).stdout.trim().split(/\r?\n/)[0];
if (!await readUpdateJson(path.join(root, "runtime.json"))) await writeFile(path.join(root, "runtime.json"), JSON.stringify({ powershell: ps }));
async function ensureClosed() {
  const expression = `$b = @(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus -ErrorAction SilentlyContinue); if ($b.Count -and -not ($b | Where-Object PowerOnline)) { throw 'Connect AC power before updating.' }; $p = '${installDir.replaceAll("'", "''")}\\'; @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($p, [StringComparison]::OrdinalIgnoreCase) }).Count`;
  const result = await command(ps, ["-NoProfile", "-NonInteractive", "-Command", expression], { windowsHide: true });
  assert.equal(Number(result.stdout.trim()), 0, "Quit the old TopBot normally before the initial managed upgrade.");
}
await ensureClosed();
let error = null, liveJob = null;
const updater = createManagedUpdater({ version: current.version, installDir, profileDir,
  dataDirs: [path.join(os.homedir(), ".openmausbot"), process.env.OMB_DATA_DIR || path.join(os.homedir(), ".openmausbot"), profileDir], root,
  setState: state => { console.log(JSON.stringify(state)); if (state.status === "error") error = new Error(state.message); },
  signals: { busy: () => false, work: async () => null }, freeze: ensureClosed, thaw: async () => {}, quit: () => {},
  find: async () => manifest, download: async (_manifest, file) => copyFile(path.join(qualifiedJob, "update.zip"), file),
  helper: (job, mode, options) => { liveJob = job; return runUpdateHelper(job, mode, options); },
});
await updater.check(true);
if (error) throw error;
assert.equal(updater.installable()?.version, manifest.version);
await updater.install();
if (error) throw error;
const deadline = Date.now() + 20 * 60 * 1000;
while (Date.now() < deadline) {
  const receipt = await readUpdateJson(path.join(liveJob, "state.json"));
  if (["failed", "rolled-back", "recovery-needed"].includes(receipt?.phase)) throw new Error(`Update ${receipt.phase}: ${receipt.message}. Journal: ${liveJob}`);
  const last = await readUpdateJson(path.join(root, "last-good.json"));
  if (last?.version === manifest.version && last.job.startsWith(path.join(root, "transactions") + path.sep)) {
    const state = await readUpdateJson(path.join(last.job, "state.json"));
    if (state?.phase === "committed") {
      await writeFile(path.join(repo, ".omb-scratch", "topbot-live-update-result.json"), JSON.stringify({ ...last, state, at: new Date().toISOString() }, null, 2));
      console.log(JSON.stringify({ installed: last.version, previous: last.previousVersion, backups: last.job }));
      process.exitCode = 0;
      break;
    }
  }
  const blocked = await readUpdateJson(path.join(root, "blocked.json"), []);
  if (blocked.includes(manifest.version)) throw new Error("The live update failed and was rolled back. Inspect the transaction journal.");
  await new Promise(resolve => setTimeout(resolve, 1000));
}
if (process.exitCode !== 0) throw new Error("Update did not commit before the monitoring deadline; inspect its journal before retrying.");

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, copyFile, writeFile, rm, readdir, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { downloadRelease, findRelease, readUpdateJson, resourcePreflight } from "./topbot-release.mjs";
import { isNewerVersion } from "./updater-coordinator.mjs";

export const updateRoot = () => process.env.TOPBOT_UPDATE_ROOT || path.join(os.homedir(), ".topbot-updates");
const runner = fileURLToPath(new URL("./topbot-update-runner.ps1", import.meta.url));
const launcher = fileURLToPath(new URL("./topbot-update-launch.ps1", import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function updatePowerShell(root) {
  const config = path.join(root, "runtime.json");
  if (existsSync(config)) {
    const executable = JSON.parse(readFileSync(config, "utf8")).powershell;
    if (typeof executable !== "string" || !path.isAbsolute(executable) || path.basename(executable).toLowerCase() !== "pwsh.exe" || !existsSync(executable)) throw new Error("Configured PowerShell 7 update runtime is unavailable.");
    return executable;
  }
  const installed = path.join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
  if (!existsSync(installed)) throw new Error("PowerShell 7 is required for managed updates. Provision the update runtime first; execution policies are not changed.");
  return installed;
}

export function runUpdateHelper(job, mode, { detached = false, spawnImpl = spawn } = {}) {
  const root = path.dirname(path.dirname(job));
  const child = spawnImpl(updatePowerShell(root), ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-File",
    path.join(job, detached ? "launch.ps1" : "runner.ps1"), "-Mode", mode, "-PlanPath", path.join(job, "plan.json")],
  { windowsHide: true, detached: false, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let message = "", output = "";
    child.stderr.on("data", chunk => { message = (message + chunk).slice(-4000); });
    child.stdout.on("data", chunk => { output = (output + chunk).slice(-4000); });
    const timer = setTimeout(() => child.kill(), detached ? 10000 : 16 * 60 * 1000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(message || `Update helper stopped (${code}).`)); return; }
      if (!detached) { resolve(); return; }
      try {
        const receipt = JSON.parse(output);
        if (!Number.isSafeInteger(receipt.pid) || receipt.pid < 1) throw new Error("Invalid update launcher receipt.");
        resolve(receipt);
      } catch (error) { reject(error); }
    });
  });
}

export async function pruneUpdateHistory(root, installDir) {
  const parent = path.join(root, "transactions");
  const last = await readUpdateJson(path.join(root, "last-good.json"));
  const terminal = [];
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
    const job = path.join(parent, entry.name);
    if (path.relative(await realpath(job), job)) continue;
    const plan = await readUpdateJson(path.join(job, "plan.json"));
    const state = await readUpdateJson(path.join(job, "state.json"));
    if (plan?.installDir !== installDir || !["committed", "rolled-back", "failed"].includes(state?.phase)) continue;
    if (state.phase === "committed") await rm(path.join(job, "update.zip"), { force: true });
    terminal.push({ job, at: Date.parse(state.at) || 0 });
  }
  terminal.sort((a, b) => b.at - a.at);
  for (const entry of terminal.slice(3)) {
    if (entry.job === last?.job) continue;
    if ((await lstat(entry.job)).isSymbolicLink() || path.relative(await realpath(entry.job), entry.job)) continue;
    await rm(entry.job, { recursive: true, force: true });
  }
}

export function createManagedUpdater({ version, installDir, dataDirs, profileDir, setState, signals, freeze, thaw, quit, canUpdate = () => true,
  root = updateRoot(), find = findRelease, download = downloadRelease, helper = runUpdateHelper, preflight = resourcePreflight }) {
  let operation = null, staged = null, installing = false;
  const errorState = error => setState({ status: "error", message: error.message, retryable: true });
  async function prepare(manifest) {
    const job = path.join(root, "transactions", randomUUID());
    await mkdir(job, { recursive: true });
    await copyFile(runner, path.join(job, "runner.ps1"));
    await copyFile(launcher, path.join(job, "launch.ps1"));
    await writeFile(path.join(job, "plan.json"), JSON.stringify({ ...manifest, previousVersion: version,
      installDir, profileDir, dataDirs: [...new Set(dataDirs.map(dir => path.resolve(dir)))].filter((dir, _, all) =>
        !all.some(parent => parent !== dir && dir.toLowerCase().startsWith(parent.toLowerCase() + path.sep))), token: randomBytes(32).toString("hex") }));
    try {
      await download(manifest, path.join(job, "update.zip"), { onProgress: percent => setState({ status: "downloading", percent }) });
      setState({ status: "preparing", version: manifest.version });
      await helper(job, "Prepare");
    } catch (error) {
      await writeFile(path.join(job, "state.json"), JSON.stringify({ phase: "failed", version: manifest.version, message: error.message, at: new Date().toISOString() }));
      throw error;
    }
    staged = { version: manifest.version, job };
    setState({ status: "downloaded", version: manifest.version, percent: undefined, message: undefined, installMode: "restart" });
  }
  function check(manual = false) {
    if (operation || installing) return operation ?? Promise.resolve();
    operation = (async () => {
      await mkdir(root, { recursive: true });
      await mkdir(path.join(root, "transactions"), { recursive: true });
      await pruneUpdateHistory(root, installDir);
      if (!canUpdate()) { if (manual) throw new Error("Connect the laptop to AC power before updating."); return; }
      if (!manual && (signals?.busy() || await signals?.work())) return;
      await preflight(root);
      setState({ status: "checking", message: undefined });
      const manifest = await find({ current: version, dataEpoch: 1 });
      const blocked = await readUpdateJson(path.join(root, "blocked.json"), []);
      if (!manifest || blocked.includes(manifest.version)) {
        setState({ status: staged ? "downloaded" : "idle", ...(staged ? { version: staged.version } : {}),
          message: manifest ? "This version was rolled back. Automatic retries are blocked until a different release is published." : undefined });
        return;
      }
      if (staged?.version === manifest.version) {
        const receipt = await readUpdateJson(path.join(staged.job, "state.json"));
        if (receipt?.phase === "prepared") { setState({ status: "downloaded", version: staged.version }); return; }
        staged = null;
      }
      setState({ status: "downloading", version: manifest.version });
      await prepare(manifest);
    })().catch(errorState).finally(() => { operation = null; });
    return operation;
  }
  async function begin(job, mode) {
    if (installing || operation) return;
    installing = true;
    let held = false;
    try {
      await preflight(root);
      if (!canUpdate()) throw new Error("Connect the laptop to AC power before updating.");
      if (signals?.busy() || await signals?.work()) throw new Error("TopBot is busy. The prepared update will wait for the current task to finish.");
      await freeze(); held = true;
      await rm(path.join(job, "helper-ready.json"), { force: true });
      const plan = await readUpdateJson(path.join(job, "plan.json"));
      const child = await helper(job, mode, { detached: true });
      const deadline = Date.now() + 15000;
      let ready = false;
      while (Date.now() < deadline) {
        if (child.exitCode != null) throw new Error(`Update helper exited before handoff (${child.exitCode}); TopBot will remain open.`);
        const receipt = await readUpdateJson(path.join(job, "helper-ready.json"));
        if (receipt?.token === plan.token && receipt.pid === child.pid) { ready = true; break; }
        await sleep(250);
      }
      if (!ready) throw new Error("Update helper did not become ready; TopBot will remain open.");
      await writeFile(path.join(job, "go.json"), JSON.stringify({ token: plan.token, pid: child.pid }));
      setState({ status: "installing", message: "Saving a data snapshot, updating and checking startup. The previous program is kept for rollback." });
      quit();
    } catch (error) {
      if (held) await thaw().catch(() => {});
      installing = false;
      errorState(error);
    }
  }
  async function rollback() {
    const last = await readUpdateJson(path.join(root, "last-good.json"));
    if (!last || last.version !== version) throw new Error("No previous version is available for this installation.");
    const job = path.resolve(last.job), parent = path.join(root, "transactions") + path.sep;
    if (!job.startsWith(parent) || path.relative(await realpath(job), job)) throw new Error("Invalid rollback record.");
    await begin(job, "Rollback");
  }
  async function status() {
    const last = await readUpdateJson(path.join(root, "last-good.json"));
    return { current: version, prepared: staged?.version ?? null,
      previous: last?.version === version ? last.previousVersion : null, root };
  }
  async function restore() {
    await mkdir(path.join(root, "transactions"), { recursive: true });
    await pruneUpdateHistory(root, installDir);
    const entries = await readdir(path.join(root, "transactions"), { withFileTypes: true });
    for (const entry of entries.slice(-100)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const job = path.join(root, "transactions", entry.name);
      const plan = await readUpdateJson(path.join(job, "plan.json"));
      const state = await readUpdateJson(path.join(job, "state.json"));
      if (plan?.previousVersion === version && isNewerVersion(plan.version, version) && plan.installDir === installDir && state?.phase === "prepared" &&
          (!staged || isNewerVersion(plan.version, staged.version))) {
        staged = { job, version: plan.version };
        setState({ status: "downloaded", version: staged.version, installMode: "restart" });
      }
      if (state?.phase === "rolled-back" && plan?.previousVersion === version) setState({ status: "error", message: `Update ${plan.version} was rolled back. Your current data was retained.`, retryable: true });
    }
  }
  return { check, install: () => staged ? begin(staged.job, "Apply") : Promise.resolve(),
    installable: () => !installing && !operation && staged ? { version: staged.version } : null, rollback, status, restore };
}

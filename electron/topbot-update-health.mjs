import { readFile, rename, writeFile, realpath } from "node:fs/promises";
import path from "node:path";

export function healthTicketPath(argv, root) {
  const value = argv.find(arg => arg.startsWith("--topbot-update-ticket="))?.split("=").slice(1).join("=");
  if (!value) return null;
  const file = path.resolve(value), relative = path.relative(path.join(root, "transactions"), file);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative.split(path.sep).length !== 2 || path.basename(file) !== "ticket.json") return null;
  return file;
}

export async function startUpdateHealth({ argv = process.argv, root, version, dataEpoch = 1, executable = process.execPath,
  ready, quit, intervalMs = 2000 }) {
  const ticketPath = healthTicketPath(argv, root);
  if (!ticketPath) return null;
  const resolved = await realpath(ticketPath);
  if (process.platform === "win32" ? resolved.toLowerCase() !== ticketPath.toLowerCase() : resolved !== ticketPath) throw new Error("Linked update health tickets are not allowed.");
  const ticket = JSON.parse(await readFile(ticketPath, "utf8"));
  if (!/^[a-f0-9]{64}$/.test(ticket.token ?? "") || ticket.version !== version || ticket.dataEpoch !== dataEpoch ||
      path.resolve(ticket.installDir, "TopBot.exe").toLowerCase() !== path.resolve(executable).toLowerCase()) throw new Error("Update health ticket does not match this app.");
  const job = path.dirname(ticketPath);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const stop = await readFile(path.join(job, "stop.json"), "utf8").then(JSON.parse).catch(() => null);
      if (stop?.token === ticket.token) { quit(); return; }
      const transaction = await readFile(path.join(job, "state.json"), "utf8").then(JSON.parse).catch(() => null);
      if (transaction?.phase === "committed") return;
      const healthy = await ready();
      const file = path.join(job, "health.json");
      await writeFile(`${file}.tmp`, JSON.stringify({ token: ticket.token, version, dataEpoch, pid: process.pid, ready: healthy === true, at: new Date().toISOString() }));
      await rename(`${file}.tmp`, file);
    } catch { /* A missing heartbeat fails closed in the independent update runner. */ }
    finally { running = false; }
  };
  await tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

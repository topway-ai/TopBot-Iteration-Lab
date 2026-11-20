import path from "node:path";
import { releaseSingleInstanceLock } from "./single-instance.mjs";
import { updateRoot } from "./topbot-managed-update.mjs";
import { healthTicketPath, startUpdateHealth } from "./topbot-update-health.mjs";
import { showManagedUpdates, startUpdater } from "./updater.mjs";

export function registerManagedDesktopMenu({ ipcMain, localOnly, requireMainWindowSender, window, dialog, shell, t, quit, platform = process.platform }) {
  if (platform !== "win32") return;
  ipcMain.handle("desktop-menu:recovery", localOnly("desktop-menu:recovery", async event => {
    requireMainWindowSender(event);
    await showManagedUpdates({ dialog, shell, parent: window() });
  }));
  ipcMain.handle("desktop-menu:quit", localOnly("desktop-menu:quit", async event => {
    requireMainWindowSender(event);
    const choice = await dialog.showMessageBox(window(), { type: "question", message: t("native.menu.quitFully") + "?",
      buttons: [t("native.common.cancel"), t("native.menu.quitFully")], defaultId: 0, cancelId: 0, noLink: true });
    if (choice.response === 1) quit();
  }));
}

export function startDesktopHidden({ app, startedHidden, reopenedOutOfSight, platform = process.platform, argv = process.argv }) {
  const hidden = startedHidden() || reopenedOutOfSight();
  // An update candidate needs a loaded desktop even if the previous window was out of sight.
  return hidden && !(app.isPackaged && platform === "win32" && healthTicketPath(argv, updateRoot()));
}

export function startManagedDesktopUpdates(signals, { app, powerMonitor, workspaceDirs, local, isServerReady, window, rendererOrigin, log, platform = process.platform }) {
  const profileDir = app.getPath("userData");
  const lab = process.env.TOPBOT_ITERATION_LAB_ROOT;
  if (lab) signals = { ...signals, locked: () => true, typedAt: () => 0, shown: () => false };
  startUpdater(signals, {
    installDir: path.dirname(process.execPath), profileDir, dataDirs: [...workspaceDirs, profileDir],
    canUpdate: () => !powerMonitor.isOnBatteryPower(),
    quit: () => { releaseSingleInstanceLock(app); app.quit(); },
    freeze: async () => {
      const before = await (await local("/api/move/freeze", { signal: AbortSignal.timeout(10000) })).json();
      if (before.frozen) throw new Error("This workspace is already frozen for another operation.");
      const response = await local("/api/move/freeze", { method: "POST", signal: AbortSignal.timeout(10000), headers: { "Content-Type": "application/json" }, body: JSON.stringify({ temporary: true }) });
      if (!response.ok) throw new Error("TopBot is still busy; update postponed.");
    },
    thaw: async () => { await local("/api/move/freeze", { method: "DELETE", signal: AbortSignal.timeout(5000), headers: { "Content-Type": "application/json" }, body: "{}" }); },
  });
  if (app.isPackaged && platform === "win32") void startUpdateHealth({
    root: updateRoot(), version: app.getVersion(), quit: () => app.quit(),
    ready: async () => {
      if (lab && process.env.TOPBOT_ITERATION_LAB_FAIL_HEALTH === "1") return false;
      const win = window();
      if (!isServerReady() || !win || win.isDestroyed() || win.webContents.isLoadingMainFrame() || win.webContents.isCrashed()) return false;
      const response = await local("/api/health", { signal: AbortSignal.timeout(5000) });
      return response.ok && window() === win && !win.isDestroyed() && new URL(win.webContents.getURL()).origin === rendererOrigin();
    },
  }).catch(error => log(`update health: ${error.message}`));
}

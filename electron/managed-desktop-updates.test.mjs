import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registerManagedDesktopMenu, startDesktopHidden, startManagedDesktopUpdates } from "./managed-desktop-updates.mjs";
import { showManagedUpdates, startUpdater } from "./updater.mjs";
import { startUpdateHealth } from "./topbot-update-health.mjs";

vi.mock("./updater.mjs", () => ({ showManagedUpdates: vi.fn(), startUpdater: vi.fn() }));
vi.mock("./topbot-update-health.mjs", async importOriginal => ({ ...await importOriginal(), startUpdateHealth: vi.fn(async () => {}) }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it("guards both commands and quits only after the affirmative native response", async () => {
  const handlers = new Map();
  const install = { ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    localOnly: vi.fn((_name, handler) => handler),
    requireMainWindowSender: vi.fn(event => { if (event !== "main") throw new Error("Not the main window"); }),
    window: () => "window", dialog: { showMessageBox: vi.fn() }, shell: {}, t: key => key, quit: vi.fn() };
  registerManagedDesktopMenu({ ...install, platform: "linux" });
  expect(handlers.size).toBe(0);
  registerManagedDesktopMenu({ ...install, platform: "win32" });
  expect(install.localOnly.mock.calls.map(([name]) => name)).toEqual(["desktop-menu:recovery", "desktop-menu:quit"]);
  const recover = handlers.get("desktop-menu:recovery"), quit = handlers.get("desktop-menu:quit");
  await expect(recover("viewer")).rejects.toThrow("Not the main window");
  await expect(quit("viewer")).rejects.toThrow("Not the main window");
  expect(showManagedUpdates).not.toHaveBeenCalled();
  expect(install.dialog.showMessageBox).not.toHaveBeenCalled();
  await recover("main");
  expect(showManagedUpdates).toHaveBeenCalledWith({ dialog: install.dialog, shell: install.shell, parent: "window" });
  install.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 });
  await quit("main");
  expect(install.quit).not.toHaveBeenCalled();
  await quit("main");
  expect(install.quit).toHaveBeenCalledTimes(1);
});

it("loads the desktop for an update ticket, even for a quiet restart", () => {
  const root = path.resolve("isolated-update-root");
  vi.stubEnv("TOPBOT_UPDATE_ROOT", root);
  const deps = { app: { isPackaged: true }, platform: "win32", startedHidden: () => false, reopenedOutOfSight: () => true };
  expect(startDesktopHidden({ ...deps, argv: [] })).toBe(true);
  expect(startDesktopHidden({ ...deps, argv: [`--topbot-update-ticket=${path.join(root, "other", "ticket.json")}`] })).toBe(true);
  const argv = [`--topbot-update-ticket=${path.join(root, "transactions", "one", "ticket.json")}`];
  expect(startDesktopHidden({ ...deps, platform: "darwin", argv })).toBe(true);
  expect(startDesktopHidden({ ...deps, argv })).toBe(false);
});

it("backs up the active workspace and profile, freezes temporarily, and checks the current local renderer", async () => {
  const local = vi.fn(async () => new Response('{"frozen":false}'));
  const contents = { isLoadingMainFrame: () => false, isCrashed: () => false, getURL: () => "http://127.0.0.1:8799/" };
  let win = { isDestroyed: () => false, webContents: contents };
  const app = { isPackaged: true, getPath: () => "profile", getVersion: () => "1.0.0" };
  startManagedDesktopUpdates({}, { app, platform: "win32", powerMonitor: { isOnBatteryPower: () => false },
    workspaceDirs: ["default", "active"], local, isServerReady: () => true, window: () => win, rendererOrigin: () => "http://127.0.0.1:8799", log: vi.fn() });
  const options = startUpdater.mock.calls[0][1];
  expect(options.dataDirs).toEqual(["default", "active", "profile"]);
  await options.freeze();
  expect(local.mock.calls[1][0]).toBe("/api/move/freeze");
  expect(JSON.parse(local.mock.calls[1][1].body)).toEqual({ temporary: true });
  const { ready } = startUpdateHealth.mock.calls[0][0];
  expect(await ready()).toBe(true);
  contents.getURL = () => "https://remote.invalid/";
  expect(await ready()).toBe(false);
  local.mockImplementationOnce(async () => { win = null; return new Response(); });
  expect(await ready()).toBe(false);
});

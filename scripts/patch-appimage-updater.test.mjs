import { expect, it } from "vitest";
import { patchAppImageUpdater } from "./patch-appimage-updater.mjs";

const source = name => [
  "destination = path2.join(path2.dirname(appImageFile), path2.basename(installerPath));",
  "(0, fs_1.unlinkSync)(appImageFile);",
  '(0, child_process_1.execFileSync)("mv", ["-f", installerPath, destination]);',
  `this.spawnLog(destination, [], ${name});`,
].join("\n");

it.each(["env", "env2"])("keeps the environment variable esbuild emitted (%s)", name => {
  const patched = patchAppImageUpdater(source(name));
  expect(patched).toContain(`process.env.APPIMAGE_SILENT_INSTALL = ${name}.APPIMAGE_SILENT_INSTALL;`);
  expect(patched).not.toContain("this.spawnLog");
  expect(patched).toContain('require("electron").app.relaunch');
});

it("refuses an ambiguous upstream change", () => {
  expect(() => patchAppImageUpdater(source("env2") + "\nthis.spawnLog(destination, [], env3);")).toThrow(/found 2/);
});

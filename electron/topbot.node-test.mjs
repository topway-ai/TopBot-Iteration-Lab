import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import nativeText from "./native-text.cjs";

const source = file => readFileSync(new URL(file, import.meta.url), "utf8");
const manifest = JSON.parse(source("../package.json"));

test("TopBot identifies its own fork and never auto-installs upstream releases", () => {
  assert.equal(manifest.name, "topbot");
  assert.equal(manifest.homepage, "https://github.com/topway-ai/TopBot-Iteration-Lab");
  assert.equal(manifest.topbot.automaticUpdates, false);
  assert.match(source("./updater.mjs"), /topbot\?\.automaticUpdates === false/);
  const packaging = source("../electron-builder.yml");
  assert.match(packaging, /productName: TopBot/);
  assert.match(packaging, /owner: topway-ai\s+repo: TopBot-Iteration-Lab/);
  assert.match(packaging, /!enterprise\{,\/\*\*\/\*\}/);
});

test("TopBot keeps the installed Windows profile without overriding isolated launches", () => {
  const main = source("./main.mjs");
  assert.match(main, /app\.isPackaged && !app\.commandLine\.hasSwitch\("user-data-dir"\)/);
  assert.match(main, /app\.setPath\("userData", path\.join\(app\.getPath\("appData"\), "openmausbot"\)\)/);
  assert.ok(main.indexOf('app.setPath("userData"') < main.indexOf("app.requestSingleInstanceLock()"));
});

test("native tray labels use TopBot", () => {
  const text = nativeText.createNativeText({ saved: "en" });
  assert.equal(text.t("native.tray.open"), "Open TopBot");
  assert.equal(text.t("native.tray.quit"), "Quit TopBot");
  assert.equal(text.t("native.cloud.addSignIn"), "Sign in to Cloud service first.");
  assert.equal(text.t("native.title.connected", { server: "Local", host: "localhost" }), "TopBot \u2014 Connected to: Local (localhost)");
});

test("TopBot removes upstream promotion surfaces and downloads", () => {
  assert.match(source("./main.mjs"), /function cloudOffersAllowed\(\) \{\s+return false;/);
  const notices = source("../src/components/AppNotices.tsx");
  for (const name of ["WhatsNewPopup", "BoatOfferCard", "ModelgoOfferCard", "UpdatesConsentDialog", "ProductHuntCard", "useAnnouncementCards"]) {
    assert.equal(notices.includes(name), false, name);
  }
  const route = source("../server/routes/announcements.ts");
  assert.equal(route.includes("announcementStore"), false);
  assert.match(route, /cards: \[\], disabled: true/);
  for (const lang of ["en", "zh"]) {
    const pack = JSON.parse(source(`../src/locales/${lang}.json`));
    for (const [key, value] of Object.entries(pack)) {
      assert.doesNotMatch(value, /\b(?:OpenMausBot|MausBot|ManusBot)\b/, key);
    }
  }
});

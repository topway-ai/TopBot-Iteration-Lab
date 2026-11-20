import { cp, mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resourcePreflight } from "../electron/topbot-release.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = path.resolve(process.argv[2] || path.join(process.env.LOCALAPPDATA, "Programs", "TopBot"));
const ui = process.argv[3] ? path.resolve(process.argv[3]) : null;
if (ui) await access(path.join(ui, "index.html"));
const scratch = path.resolve(process.env.TOPBOT_LOCAL_BUILD_SCRATCH || path.join(root, ".omb-scratch"));
await mkdir(scratch, { recursive: true });
await resourcePreflight(scratch, 4 * 1024 ** 3);
const out = await mkdtemp(path.join(scratch, "local-update-build-"));
const app = path.join(out, "TopBot"), source = path.join(out, "asar-source");
console.log(JSON.stringify({ base, app }));
await cp(base, app, { recursive: true, dereference: false, filter: entry => !ui || entry !== path.join(base, "resources", "ui") });
if (ui) await cp(ui, path.join(app, "resources", "ui"), { recursive: true });
await mkdir(source, { recursive: true });
await cp(path.join(root, "electron"), path.join(source, "electron"), { recursive: true,
  filter: entry => !/\.(?:node-test|test)\.[mc]?js$/.test(entry) && !entry.includes(`${path.sep}fixtures`) });
await cp(path.join(root, "src", "locales"), path.join(source, "src", "locales"), { recursive: true });
await cp(path.join(root, "package.json"), path.join(source, "package.json"));
const builder = createRequire(import.meta.resolve("electron-builder"));
const asar = createRequire(builder.resolve("app-builder-lib"))("@electron/asar");
await asar.createPackage(source, path.join(app, "resources", "app.asar"));
await cp(path.join(root, "dist-server"), path.join(app, "resources", "server"), { recursive: true });
await cp(path.join(root, "skills"), path.join(app, "resources", "skills"), { recursive: true });
const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
await writeFile(path.join(app, "resources", "topbot-build.json"), JSON.stringify({ version: metadata.version, dataEpoch: metadata.topbot.dataEpoch, repository: "topway-ai/TopBot-Iteration-Lab" }));
await writeFile(path.join(scratch, "topbot-local-build.json"), JSON.stringify({ app, version: metadata.version, base,
  ui: ui ?? "Reused the installed renderer.", at: new Date().toISOString() }, null, 2));
console.log(`Candidate: ${app}`);

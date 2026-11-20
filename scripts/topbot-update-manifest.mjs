import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkManifest, MANIFEST_NAME, REPOSITORY } from "../electron/topbot-release.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const release = path.resolve(process.argv[2] || path.join(root, "release"));
const app = path.join(release, "win-unpacked");
const build = JSON.parse(await readFile(path.join(app, "resources", "topbot-build.json"), "utf8"));
const archive = path.join(release, `TopBot-${build.version}-x64.zip`);
let unpackedBytes = 0;
async function size(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    const details = await lstat(full);
    if (details.isSymbolicLink()) throw new Error(`Update package contains a link: ${full}`);
    if (entry.isDirectory()) await size(full);
    else unpackedBytes += details.size;
  }
}
await size(app);
const hash = createHash("sha256");
for await (const chunk of createReadStream(archive)) hash.update(chunk);
const manifest = checkManifest({ schema: 1, repository: REPOSITORY, platform: "win32-x64", version: build.version,
  dataEpoch: build.dataEpoch, bytes: (await stat(archive)).size, unpackedBytes, sha256: hash.digest("hex"),
  url: `https://github.com/${REPOSITORY}/releases/download/v${build.version}/${path.basename(archive)}` });
await writeFile(path.join(release, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const file = (name) => fileURLToPath(new URL(`../${name}`, import.meta.url));
const source = readFileSync(file("build/topbot-logo-source.png"));
const crop = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 724 724"><image x="-80" y="0" width="2172" height="724" href="data:image/png;base64,${source.toString("base64")}"/></svg>`;
const png = (size) => new Resvg(crop, { fitTo: { mode: "width", value: size } }).render().asPng();
const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 192, 256, 512, 1024];
const images = new Map(sizes.map((size) => [size, png(size)]));
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-labelledby="title desc"><title id="title">TopBot</title><desc id="desc">The approved blue-violet TopBot robot emblem.</desc><image width="1024" height="1024" href="data:image/png;base64,${images.get(1024).toString("base64")}"/></svg>\n`;

for (const target of ["build/icon.svg", "public/app-icon.svg"]) writeFileSync(file(target), icon);
for (const [target, size] of [["build/icon-1024.png", 1024], ["electron/resources/app-icon.png", 256], ["public/app-icon-192.png", 192], ["public/app-icon-512.png", 512]]) {
  writeFileSync(file(target), images.get(size));
}
writeFileSync(file("public/apple-touch-icon.png"), png(180));
writeFileSync(file("public/topbot-logo.png"), source);
for (const size of [16, 32, 64, 128, 256, 512]) {
  writeFileSync(file(`build/icon.iconset/icon_${size}x${size}.png`), images.get(size));
  writeFileSync(file(`build/icon.iconset/icon_${size}x${size}@2x.png`), images.get(size * 2));
}

// ICO directory entries use zero for a 256px dimension; each payload is a complete PNG.
const frames = sizes.filter((size) => size <= 256);
const header = Buffer.alloc(6 + frames.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(frames.length, 4);
let offset = header.length;
for (const [index, size] of frames.entries()) {
  const entry = 6 + index * 16;
  const image = images.get(size);
  header[entry] = header[entry + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(image.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += image.length;
}
writeFileSync(file("build/icon.ico"), Buffer.concat([header, ...frames.map((size) => images.get(size))]));

// Modern ICNS elements contain PNG data; the container and element lengths are big-endian.
const chunks = [["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024]].map(([type, size]) => {
  const image = images.get(size);
  const chunk = Buffer.alloc(8);
  chunk.write(type, 0, "ascii");
  chunk.writeUInt32BE(image.length + 8, 4);
  return Buffer.concat([chunk, image]);
});
const icns = Buffer.alloc(8);
icns.write("icns", 0, "ascii");
icns.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
writeFileSync(file("build/icon.icns"), Buffer.concat([icns, ...chunks]));
console.log("TopBot desktop, tray, web and mobile icons generated from the approved logo.");

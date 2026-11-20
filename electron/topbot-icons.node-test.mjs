import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url));
const pngSize = (data) => {
  assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(data.toString("ascii", 12, 16), "IHDR");
  assert.equal(data[25], 6, "icons keep an alpha channel");
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
};

test("desktop and web assets share the approved TopBot artwork", () => {
  assert.deepEqual(read("public/topbot-logo.png"), read("build/topbot-logo-source.png"));
  for (const [path, size] of [["build/icon-1024.png", 1024], ["electron/resources/app-icon.png", 256],
    ["public/app-icon-192.png", 192], ["public/app-icon-512.png", 512], ["public/apple-touch-icon.png", 180]]) {
    assert.deepEqual(pngSize(read(path)), [size, size], path);
  }
  const svg = read("public/app-icon.svg").toString();
  assert.equal(svg, read("build/icon.svg").toString());
  assert.match(svg, /<title id="title">TopBot<\/title>/);
  assert.ok(svg.includes(read("build/icon-1024.png").toString("base64")));
});

test("Windows ICO includes valid transparent PNG frames from 16 through 256 pixels", () => {
  const ico = read("build/icon.ico");
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const count = ico.readUInt16LE(4);
  const sizes = [];
  let end = 6 + count * 16;
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16;
    const size = ico[entry] || 256;
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    assert.equal(offset, end);
    assert.equal(ico.readUInt16LE(entry + 6), 32);
    assert.deepEqual(pngSize(ico.subarray(offset, offset + length)), [size, size]);
    sizes.push(size);
    end = offset + length;
  }
  assert.deepEqual(sizes, [16, 20, 24, 32, 40, 48, 64, 96, 128, 192, 256]);
  assert.equal(end, ico.length);
});

test("macOS ICNS has complete PNG elements and a consistent container length", () => {
  const data = read("build/icon.icns");
  assert.equal(data.toString("ascii", 0, 4), "icns");
  assert.equal(data.readUInt32BE(4), data.length);
  const expected = new Map([["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024]]);
  let offset = 8;
  while (offset < data.length) {
    const type = data.toString("ascii", offset, offset + 4);
    const length = data.readUInt32BE(offset + 4);
    const size = expected.get(type);
    assert.ok(size);
    assert.ok(length > 8);
    assert.deepEqual(pngSize(data.subarray(offset + 8, offset + length)), [size, size]);
    expected.delete(type);
    offset += length;
  }
  assert.equal(offset, data.length);
  assert.equal(expected.size, 0);
});

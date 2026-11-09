import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PNG } from "pngjs";

import {
  changedPixelRatio,
  captureWhenStable,
  decodePngPixels,
  hashPngPixels,
} from "../src/lib.js";

test("preserves the final PNG and timeout diagnostics when frames keep changing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "snapbot-timeout-"));
  const outputPath = path.join(root, "capture.png");
  let captured = 0;
  let lastFrame: Buffer | undefined;
  try {
    const result = await captureWhenStable({
      outputPath,
      temporaryDirectory: path.join(root, "samples"),
      settings: {
        minimumWaitMs: 0,
        sampleIntervalMs: 50,
        stableSamples: 3,
        timeoutMs: 1000,
      },
      captureSample: async (samplePath) => {
        const frame = new PNG({ width: 1, height: 1 });
        frame.data = Buffer.from([captured++ % 2 ? 255 : 0, 0, 0, 255]);
        lastFrame = PNG.sync.write(frame);
        await writeFile(samplePath, lastFrame);
      },
      assertAlive: () => {},
      log: () => {},
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.stable, false);
    assert.ok(result.samples >= 3);
    assert.deepEqual(await readFile(outputPath), lastFrame);
    assert.equal(result.pixelHash, hashPngPixels(lastFrame!).hash);
    assert.deepEqual(await readdir(root), ["capture.png"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const PIXELS = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]);

function testPng(compressionLevel: number): Buffer {
  const image = new PNG({ width: 2, height: 1 });
  image.data = PIXELS;
  return PNG.sync.write(image, { deflateLevel: compressionLevel });
}

test("decodes PNGs to canonical RGBA pixels", () => {
  const decoded = decodePngPixels(testPng(1));
  assert.deepEqual(decoded, { width: 2, height: 1, rgba: PIXELS });
});

test("pixel hash ignores PNG compression differences", () => {
  const first = hashPngPixels(testPng(1));
  const second = hashPngPixels(testPng(9));
  assert.equal(first.hash, second.hash);
  assert.equal(
    first.hash,
    createHash("sha256").update("2x1\0").update(PIXELS).digest("hex"),
  );
});

test("counts only pixels that changed beyond colour noise", () => {
  const frame = (rgba: number[]) => ({
    width: 2,
    height: 1,
    rgba: Buffer.from(rgba),
  });
  const base = frame([10, 10, 10, 255, 10, 10, 10, 255]);

  assert.equal(
    changedPixelRatio(base, frame([14, 10, 10, 255, 10, 10, 10, 255])),
    0,
  );
  assert.equal(
    changedPixelRatio(base, frame([200, 10, 10, 255, 10, 10, 10, 255])),
    0.5,
  );
  assert.equal(changedPixelRatio(base, { ...base, width: 1, height: 2 }), 1);
});

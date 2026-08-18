import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { looksLikeText, MAX_SNAPSHOT_FILE_BYTES, readTextFile, takeContentSnapshot } from "../snapshot.ts";

describe("looksLikeText", () => {
  it("accepts utf-8 text and rejects binary", () => {
    assert.equal(looksLikeText(Buffer.from("hello\n世界\n")), true);
    assert.equal(looksLikeText(Buffer.from([0x68, 0x00, 0x69])), false); // NUL byte
    assert.equal(looksLikeText(Buffer.from([0xff, 0xfe, 0xfd])), false); // invalid utf-8
  });
});

describe("readTextFile", () => {
  it("returns content for text files, undefined for missing/binary/oversized", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-file-diff-snap-"));
    try {
      await writeFile(join(dir, "t.txt"), "abc\n");
      await writeFile(join(dir, "b.bin"), Buffer.from([0x00, 0x01]));
      await writeFile(join(dir, "big.txt"), "x".repeat(MAX_SNAPSHOT_FILE_BYTES + 1));

      assert.equal(await readTextFile(join(dir, "t.txt")), "abc\n");
      assert.equal(await readTextFile(join(dir, "b.bin")), undefined);
      assert.equal(await readTextFile(join(dir, "big.txt")), undefined);
      assert.equal(await readTextFile(join(dir, "missing.txt")), undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("takeContentSnapshot", () => {
  it("captures text files, skips ignored dirs and binary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-file-diff-snap-"));
    try {
      await writeFile(join(dir, "a.txt"), "alpha\n");
      await mkdir(join(dir, "sub"));
      await writeFile(join(dir, "sub", "b.md"), "beta");
      await mkdir(join(dir, "node_modules"));
      await writeFile(join(dir, "node_modules", "x.js"), "skip me");
      await writeFile(join(dir, "bin.dat"), Buffer.from([0x00, 0x01]));

      const snap = await takeContentSnapshot(dir);
      assert.equal(snap.contents.get(join(dir, "a.txt")), "alpha\n");
      assert.equal(snap.contents.get(join(dir, "sub", "b.md")), "beta");
      assert.equal(snap.contents.has(join(dir, "node_modules", "x.js")), false);
      assert.equal(snap.contents.has(join(dir, "bin.dat")), false);
      assert.equal(snap.seen.has(join(dir, "a.txt")), true);
      assert.equal(snap.seen.has(join(dir, "node_modules", "x.js")), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * pi-file-diff — performance benchmark.
 *
 * Measures the three workspace operations on synthetic projects of
 * increasing size. Run: node bench/bench.ts
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFileSet, takeContentSnapshot } from "../src/snapshot.ts";
import { ChangeTracker } from "../src/tracker.ts";

interface Result {
  files: number;
  fileSetMs: number;
  snapshotMs: number;
  bashScanMs: number;
  snapshotCount: number;
  memoryDeltaMB: number;
}

async function buildWorkspace(totalFiles: number, dir: string): Promise<void> {
  const dirs = 40;
  for (let d = 0; d < dirs; d++) {
    await mkdir(join(dir, `pkg${d}`));
  }
  // keep a text file around for the bash-diff step
  await writeFile(join(dir, "pkg0", "target.txt"), "hello\n");
  let i = 0;
  const CHUNK = 4_000;
  const tasks: Promise<void>[] = [];
  for (; i < totalFiles; i++) {
    tasks.push(writeFile(join(dir, `pkg${i % dirs}`, `f${i}.js`), `// file ${i}\nconst x = ${i};\nexport default x;\n`));
    if (tasks.length >= CHUNK) {
      await Promise.all(tasks);
      tasks.length = 0;
    }
  }
  await Promise.all(tasks);
}

async function bench(files: number): Promise<Result> {
  const dir = await mkdtemp(join(tmpdir(), "pi-file-diff-bench-"));
  const memBefore = process.memoryUsage().heapUsed;
  try {
    await buildWorkspace(files, dir);

    // 1. stat-only file set (per-run baseline)
    let t0 = performance.now();
    const seen = await collectFileSet(dir);
    const fileSetMs = performance.now() - t0;

    // 2. content snapshot (bounded at 32 MB)
    t0 = performance.now();
    const snap = await takeContentSnapshot(dir);
    const snapshotMs = performance.now() - t0;

    // 3. bash-change scan with one modified + one new file
    await writeFile(join(dir, "pkg0", "target.txt"), "hello\nappended line\n");
    await writeFile(join(dir, "pkg0", "new-gen.txt"), "generated\n");
    const tracker = new ChangeTracker(dir);
    t0 = performance.now();
    await tracker.collectBashChanges(Date.now() - 5_000, snap.contents);
    const bashScanMs = performance.now() - t0;

    const memoryDeltaMB = (process.memoryUsage().heapUsed - memBefore) / 1024 / 1024;
    return { files, fileSetMs, snapshotMs, bashScanMs, snapshotCount: snap.contents.size, memoryDeltaMB };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const sizes = [150_000, 300_000, 600_000];

console.log("files | fileSet(ms) | snapshot(ms) | bashScan(ms) | snapshotFiles | heapDelta(MB)");
console.log("------|-------------|--------------|--------------|---------------|--------------");
for (const size of sizes) {
  const r = await bench(size);
  console.log(
    `${String(r.files).padStart(5)} | ${r.fileSetMs.toFixed(0).padStart(9)} | ${r.snapshotMs.toFixed(0).padStart(10)} | ${r.bashScanMs.toFixed(0).padStart(10)} | ${String(r.snapshotCount).padStart(11)} | ${r.memoryDeltaMB.toFixed(1).padStart(9)}`,
  );
}

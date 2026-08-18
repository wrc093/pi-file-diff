import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enMessages, isLang, messagesFor, resolveConfig, resolveLang, zhMessages } from "../i18n.ts";

describe("resolveLang", () => {
  const origEnv = process.env.PI_FILE_DIFF_LANG;

  afterEach(() => {
    if (origEnv === undefined) delete process.env.PI_FILE_DIFF_LANG;
    else process.env.PI_FILE_DIFF_LANG = origEnv;
  });

  it("defaults to en", () => {
    delete process.env.PI_FILE_DIFF_LANG;
    assert.equal(resolveLang(undefined), "en");
  });

  it("honors the PI_FILE_DIFF_LANG env var", () => {
    process.env.PI_FILE_DIFF_LANG = "zh";
    assert.equal(resolveLang(undefined), "zh");
    process.env.PI_FILE_DIFF_LANG = "EN";
    assert.equal(resolveLang(undefined), "en");
  });

  it("ignores unknown env values", () => {
    process.env.PI_FILE_DIFF_LANG = "fr";
    assert.equal(resolveLang(undefined), "en");
  });

  it("reads lang from <agentDir>/file-diff.json", async () => {
    delete process.env.PI_FILE_DIFF_LANG;
    const dir = await mkdtemp(join(tmpdir(), "pi-file-diff-i18n-"));
    try {
      await writeFile(join(dir, "file-diff.json"), JSON.stringify({ lang: "zh" }));
      assert.equal(resolveLang(dir), "zh");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("env var wins over config file", async () => {
    process.env.PI_FILE_DIFF_LANG = "en";
    const dir = await mkdtemp(join(tmpdir(), "pi-file-diff-i18n-"));
    try {
      await writeFile(join(dir, "file-diff.json"), JSON.stringify({ lang: "zh" }));
      assert.equal(resolveLang(dir), "en");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("tolerates a missing/invalid config file", async () => {
    delete process.env.PI_FILE_DIFF_LANG;
    const dir = await mkdtemp(join(tmpdir(), "pi-file-diff-i18n-"));
    try {
      await writeFile(join(dir, "file-diff.json"), "{not json");
      assert.equal(resolveLang(dir), "en");
      assert.equal(resolveLang(join(dir, "nope")), "en");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("messagesFor", () => {
  it("returns the matching message table", () => {
    assert.equal(messagesFor("en"), enMessages);
    assert.equal(messagesFor("zh"), zhMessages);
  });
});

describe("isLang", () => {
  it("accepts only en/zh", () => {
    assert.equal(isLang("en"), true);
    assert.equal(isLang("zh"), true);
    assert.equal(isLang("fr"), false);
    assert.equal(isLang(undefined), false);
  });
});

describe("resolveConfig", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env.PI_FILE_DIFF_LANG = origEnv.PI_FILE_DIFF_LANG;
    process.env.PI_FILE_DIFF_BASH_TRACKING = origEnv.PI_FILE_DIFF_BASH_TRACKING;
  });

  it("defaults to en / auto with the default threshold", () => {
    delete process.env.PI_FILE_DIFF_LANG;
    delete process.env.PI_FILE_DIFF_BASH_TRACKING;
    assert.deepEqual(resolveConfig(undefined), {
      lang: "en",
      bashTracking: "auto",
      bashThreshold: 200_000,
      ignore: [],
      exclude: [],
    });
  });

  it("reads both fields from the config file", async () => {
    delete process.env.PI_FILE_DIFF_LANG;
    delete process.env.PI_FILE_DIFF_BASH_TRACKING;
    const dir = await mkdtemp(join(tmpdir(), "pi-file-diff-cfg-"));
    try {
      await writeFile(
        join(dir, "file-diff.json"),
        JSON.stringify({
          lang: "zh",
          bashTracking: "off",
          bashThreshold: 50000,
          ignore: ["my_vendor"],
          exclude: ["vendor/deps", "/abs/path/file.txt"],
        }),
      );
      assert.deepEqual(resolveConfig(dir), {
        lang: "zh",
        bashTracking: "off",
        bashThreshold: 50000,
        ignore: ["my_vendor"],
        exclude: ["vendor/deps", "/abs/path/file.txt"],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("env vars win over the config file", async () => {
    process.env.PI_FILE_DIFF_BASH_TRACKING = "on";
    const dir = await mkdtemp(join(tmpdir(), "pi-file-diff-cfg-"));
    try {
      await writeFile(join(dir, "file-diff.json"), JSON.stringify({ lang: "zh", bashTracking: "off" }));
      const cfg = resolveConfig(dir);
      assert.equal(cfg.bashTracking, "on");
      assert.equal(cfg.lang, "zh");
      assert.equal(cfg.bashThreshold, 200_000); // file has no threshold → default
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores invalid bash tracking values", async () => {
    delete process.env.PI_FILE_DIFF_LANG;
    delete process.env.PI_FILE_DIFF_BASH_TRACKING;
    const dir = await mkdtemp(join(tmpdir(), "pi-file-diff-cfg-"));
    try {
      await writeFile(
        join(dir, "file-diff.json"),
        JSON.stringify({ bashTracking: "maybe", bashThreshold: -5, ignore: [42, "x"] }),
      );
      const cfg = resolveConfig(dir);
      assert.equal(cfg.bashTracking, "auto");
      assert.equal(cfg.bashThreshold, 200_000); // invalid threshold falls back
      assert.deepEqual(cfg.ignore, ["x"]); // non-strings dropped
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

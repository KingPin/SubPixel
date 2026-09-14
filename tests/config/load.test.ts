import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "../../src/core/errors.js";
import { loadConfig } from "../../src/config/load.js";

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "subpixel-config-"));
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
  return root;
}

describe("loadConfig", () => {
  it("returns an empty config when there is none", async () => {
    const root = await project({});
    const loaded = await loadConfig({ cwd: root, stopAt: root });
    expect(loaded.config).toEqual({});
    expect(loaded.path).toBeUndefined();
    expect(loaded.dir).toBe(root);
  });

  it("reads subpixel.config.json from the starting directory", async () => {
    const root = await project({ "subpixel.config.json": '{ "format": "webp" }' });
    const loaded = await loadConfig({ cwd: root, stopAt: root });
    expect(loaded.config.format).toBe("webp");
    expect(loaded.path).toBe(join(root, "subpixel.config.json"));
  });

  it("walks up to find the nearest config", async () => {
    const root = await project({
      "subpixel.config.json": '{ "format": "webp" }',
      "packages/site/.keep": "",
    });
    const loaded = await loadConfig({ cwd: join(root, "packages", "site"), stopAt: root });
    expect(loaded.config.format).toBe("webp");
    expect(loaded.dir).toBe(root);
  });

  it("reads the subpixel key out of package.json", async () => {
    const root = await project({
      "package.json": '{ "name": "site", "subpixel": { "outDir": "public/img" } }',
    });
    const loaded = await loadConfig({ cwd: root, stopAt: root });
    expect(loaded.config.outDir).toBe(join(root, "public", "img"));
  });

  it("ignores a package.json with no subpixel key and keeps walking", async () => {
    const root = await project({
      "subpixel.config.json": '{ "format": "jpeg" }',
      "packages/site/package.json": '{ "name": "site" }',
    });
    const loaded = await loadConfig({ cwd: join(root, "packages", "site"), stopAt: root });
    expect(loaded.config.format).toBe("jpeg");
  });

  it("prefers subpixel.config.json over package.json in the same directory", async () => {
    const root = await project({
      "subpixel.config.json": '{ "format": "png" }',
      "package.json": '{ "subpixel": { "format": "webp" } }',
    });
    const loaded = await loadConfig({ cwd: root, stopAt: root });
    expect(loaded.config.format).toBe("png");
  });

  it("resolves outDir against the config file, not the working directory", async () => {
    const root = await project({
      "subpixel.config.json": '{ "outDir": "public/images" }',
      "packages/site/.keep": "",
    });
    const loaded = await loadConfig({ cwd: join(root, "packages", "site"), stopAt: root });
    expect(loaded.config.outDir).toBe(join(root, "public", "images"));
  });

  it("leaves an absolute outDir alone", async () => {
    const root = await project({ "subpixel.config.json": '{ "outDir": "/var/assets" }' });
    const loaded = await loadConfig({ cwd: root, stopAt: root });
    expect(loaded.config.outDir).toBe("/var/assets");
  });

  it("throws ConfigError naming the file on malformed JSON", async () => {
    const root = await project({ "subpixel.config.json": "{ not json" });
    await expect(loadConfig({ cwd: root, stopAt: root })).rejects.toThrow(ConfigError);
    await expect(loadConfig({ cwd: root, stopAt: root })).rejects.toThrow(/subpixel\.config\.json/);
  });

  it("passes the warning sink through to validation", async () => {
    const warn = vi.fn();
    const root = await project({ "subpixel.config.json": '{ "colour": "blue" }' });
    await loadConfig({ cwd: root, stopAt: root, warn });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("colour"));
  });
});

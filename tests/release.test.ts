import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const RELEASE = parse(await readFile(".github/workflows/release.yml", "utf8"));
const CI = parse(await readFile(".github/workflows/ci.yml", "utf8"));
const ENGINES = JSON.parse(await readFile("package.json", "utf8")).engines.node as string;

describe("the release workflow", () => {
  it("packs on the lowest supported Node", () => {
    // The tarball is built once, on the oldest runtime the package claims to
    // support, so a syntax error that only that version rejects is caught before
    // publishing rather than by the first user on it. Three places have to agree
    // and none of them can see the other two.
    const matrix: string[] = CI.jobs.test.strategy.matrix.node;
    expect(RELEASE.env.PACK_NODE).toBe(matrix.reduce((a, b) => (Number(a) < Number(b) ? a : b)));
    expect(ENGINES).toContain(RELEASE.env.PACK_NODE);
  });

  it("asks for the permissions trusted publishing needs, and no more", () => {
    expect(RELEASE.permissions).toEqual({ "id-token": "write", contents: "read" });
  });

  it("carries no npm token", () => {
    // Trusted publishing over OIDC needs no secret. A token appearing here means
    // someone reintroduced a credential the release does not need.
    const text = JSON.stringify(RELEASE);
    expect(text).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
  });
});

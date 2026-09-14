import { describe, expect, it } from "vitest";
import { sniffFormat } from "../../src/engine/output.js";
import { tinyPng } from "./tiny.png.js";

describe("tiny png fixture", () => {
  it("is a PNG the engine recognises", () => {
    const bytes = tinyPng();
    expect(bytes).toHaveLength(74);
    expect(sniffFormat(bytes)).toBe("png");
  });
});

import { describe, expect, it } from "vitest";
import {
  altTextFor,
  emit,
  emitHtml,
  emitJsx,
  emitMarkdown,
  toJsonResult,
} from "../../src/engine/emit.js";

const RESULT = {
  images: [
    {
      path: "/work/assets/a-red-fox-1234abcd.png",
      bytes: 2048,
      format: "png" as const,
      sha256: "f".repeat(64),
      width: 1024,
      height: 1536,
    },
  ],
  backend: "codex-http" as const,
  model: "gpt-5.6-sol",
  cached: false,
  effectivePrompt: "a red fox",
  elapsedMs: 4200,
  // Required on `GenerateResult` as of Task 18. This fixture is passed to
  // `toJsonResult` and `emit`, both of which take a full `GenerateResult`, so
  // leaving it out here fails the typecheck two tasks later, not here.
  requested: 1,
};

describe("altTextFor", () => {
  it("uses the prompt", () => {
    expect(altTextFor("a red fox in snow")).toBe("a red fox in snow");
  });

  it("caps the length at 120 characters", () => {
    expect(altTextFor("word ".repeat(60)).length).toBeLessThanOrEqual(120);
  });

  it("does not end mid-word", () => {
    const alt = altTextFor(`${"a".repeat(50)} ${"b".repeat(200)}`);
    expect(alt.endsWith("…")).toBe(true);
    expect(alt).not.toContain("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("strips the augmentation block", () => {
    expect(altTextFor("a fox\n\n[Image requirements]\n- 2:3 portrait")).toBe("a fox");
  });

  it("collapses whitespace", () => {
    expect(altTextFor("a   red\n\tfox")).toBe("a red fox");
  });
});

describe("toJsonResult", () => {
  it("produces the documented shape", () => {
    const json = toJsonResult(RESULT, "/work");
    expect(json.ok).toBe(true);
    expect(json.model).toBe("gpt-5.6-sol");
    expect(json.backend).toBe("codex-http");
    expect(json.cached).toBe(false);
    expect(json.elapsedMs).toBe(4200);
    expect(json.images[0]!.relativePath).toBe("assets/a-red-fox-1234abcd.png");
    expect(json.images[0]!.alt).toBe("a red fox");
    expect(json.images[0]!.sha256).toBe("f".repeat(64));
  });

  it("falls back to the absolute path when it is outside the base", () => {
    const json = toJsonResult(RESULT, "/elsewhere");
    expect(json.images[0]!.relativePath).toBe("/work/assets/a-red-fox-1234abcd.png");
  });

  it("round-trips through JSON.stringify", () => {
    expect(() => JSON.parse(JSON.stringify(toJsonResult(RESULT, "/work")))).not.toThrow();
  });

  it("keeps a credential out of the alt text and every snippet", () => {
    // Synthetic value, not a real key. Alt text is the one prompt-derived string
    // that reaches stdout on a SUCCESSFUL run, and it is copied verbatim into the
    // Markdown, JSX, and HTML snippets a user pastes into their source.
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
    const leaky = { ...RESULT, effectivePrompt: `diagram this config: ${secret}` };
    for (const text of [
      JSON.stringify(toJsonResult(leaky, "/work")),
      emit(leaky, "/work", "json"),
      emit(leaky, "/work", "markdown"),
      emit(leaky, "/work", "jsx"),
      emit(leaky, "/work", "html"),
    ]) {
      expect(text).not.toContain("sk-proj");
      expect(text).not.toContain("abcdefghijklmnop");
    }
    expect(toJsonResult(leaky, "/work").images[0]!.alt).toContain("[REDACTED]");
  });

  it("omits failures when nothing failed", () => {
    const json = toJsonResult(RESULT, "/work");
    expect(json.requested).toBe(1);
    expect(json.skipped).toBe(0);
    expect(json.failures).toBeUndefined();
  });

  // This goes through emit(), not toJsonResult(), because emit() is what the CLI
  // calls. A contract that only holds one function deeper is not the contract.
  it("reports a partial batch through the CLI emitter", () => {
    const partial = {
      ...RESULT,
      requested: 3,
      failures: [{ index: 1, kind: "ContentPolicy", message: "refused" }],
    };
    const json = JSON.parse(emit(partial, "/work", "json"));
    expect(json.ok).toBe(false);
    expect(json.requested).toBe(3);
    expect(json.failures).toEqual([{ index: 1, kind: "ContentPolicy", message: "refused" }]);
    expect(json.skipped).toBe(1); // 3 requested - 1 produced - 1 failed
    expect(json.images).toHaveLength(1);
  });
});

describe("emitters", () => {
  it("emits Markdown", () => {
    expect(emitMarkdown(toJsonResult(RESULT, "/work"))).toBe(
      "![a red fox](assets/a-red-fox-1234abcd.png)",
    );
  });

  it("emits JSX with dimensions", () => {
    expect(emitJsx(toJsonResult(RESULT, "/work"))).toBe(
      '<img src="assets/a-red-fox-1234abcd.png" alt="a red fox" width={1024} height={1536} />',
    );
  });

  it("emits JSX without dimensions when they are unknown", () => {
    const noDims = { ...RESULT, images: [{ ...RESULT.images[0]!, width: undefined, height: undefined }] };
    expect(emitJsx(toJsonResult(noDims, "/work"))).toBe(
      '<img src="assets/a-red-fox-1234abcd.png" alt="a red fox" />',
    );
  });

  it("escapes HTML in alt text", () => {
    const risky = { ...RESULT, effectivePrompt: 'a "fox" & <hound>' };
    const html = emitHtml(toJsonResult({ ...risky }, "/work"), 'a "fox" & <hound>');
    expect(html).toContain("&quot;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&lt;hound&gt;");
    expect(html).not.toContain('alt="a "fox"');
  });

  it("emits one line per image", () => {
    const two = {
      ...RESULT,
      images: [RESULT.images[0]!, { ...RESULT.images[0]!, path: "/work/assets/b.png" }],
    };
    expect(emitMarkdown(toJsonResult(two, "/work")).split("\n")).toHaveLength(2);
  });

  it("escapes brackets in Markdown alt text", () => {
    const risky = { ...RESULT, effectivePrompt: "a [fox] and a \\hound" };
    const md = emitMarkdown(toJsonResult(risky, "/work"));
    expect(md).toContain("\\[fox\\]");
    expect(md).toContain("\\\\hound");
  });

  it("wraps a Markdown path that contains spaces or parentheses", () => {
    const spaced = {
      ...RESULT,
      images: [{ ...RESULT.images[0]!, path: "/work/assets/a fox (final).png" }],
    };
    const md = emitMarkdown(toJsonResult(spaced, "/work"));
    // Without the angle-bracket form the link ends at the first parenthesis.
    expect(md).toContain("(<assets/a fox (final).png>)");
  });

  it("escapes quotes in JSX alt text and paths", () => {
    const risky = {
      ...RESULT,
      effectivePrompt: 'a "fox" & <hound>',
      images: [{ ...RESULT.images[0]!, path: '/work/assets/say "hi".png' }],
    };
    const jsx = emitJsx(toJsonResult(risky, "/work"));
    expect(jsx).toContain("&quot;fox&quot;");
    expect(jsx).toContain("&amp;");
    expect(jsx).toContain("say &quot;hi&quot;.png");
    expect(jsx.match(/"/g)!.length).toBe(4); // Exactly the four attribute delimiters.
  });

  it("escapes the src attribute in HTML", () => {
    const risky = {
      ...RESULT,
      images: [{ ...RESULT.images[0]!, path: '/work/assets/x" onerror="alert(1).png' }],
    };
    const html = emitHtml(toJsonResult(risky, "/work"));
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain("&quot; onerror=&quot;");
  });
});

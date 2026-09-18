import { describe, expect, it, vi } from "vitest";
import { describeEvent, eventSink } from "../../src/core/events.js";

describe("describeEvent", () => {
  it("names the stage on its own when nothing identifies the image", () => {
    expect(describeEvent({ stage: "submitting" })).toBe("submitting");
  });

  it("numbers an image of a batch from one", () => {
    expect(describeEvent({ stage: "done", index: 2 })).toBe("image 3: done");
  });

  it("prefers the assets.yml id over the index", () => {
    expect(describeEvent({ stage: "done", index: 0, assetId: "hero" })).toBe("hero: done");
  });

  it("appends the message", () => {
    expect(describeEvent({ stage: "done", index: 0, message: "/out/fox.png" })).toBe(
      "image 1: done — /out/fox.png",
    );
  });

  // The whole point of the flag. Only `--json` published `cached`, so the line an
  // agent actually watches could not tell a free hit from a paid generation, and the
  // one thing worth knowing about a run that just finished is whether it cost money.
  it("says when the image was free", () => {
    expect(describeEvent({ stage: "done", index: 0, cached: true, message: "/out/fox.png" })).toBe(
      "image 1: done (cached) — /out/fox.png",
    );
  });

  it("says nothing extra when it was not", () => {
    expect(describeEvent({ stage: "done", index: 0, cached: false })).toBe("image 1: done");
  });
});

describe("eventSink", () => {
  it("is a no-op when nobody is listening", () => {
    expect(() => eventSink(undefined)({ stage: "done" })).not.toThrow();
  });

  it("swallows a listener that throws, because it is not worth a paid image", () => {
    const onEvent = vi.fn(() => {
      throw new Error("the progress bar broke");
    });
    expect(() => eventSink(onEvent)({ stage: "done" })).not.toThrow();
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The live suite spends real quota. One env var both un-excludes it here and
    // un-skips it in the file, so there is a single switch and no way to run it
    // by accident.
    exclude: [
      "node_modules/**",
      "dist/**",
      ...(process.env.SUBPIXEL_LIVE === "1" ? [] : ["tests/live/**"]),
    ],
    environment: "node",
    testTimeout: 10_000,
  },
});

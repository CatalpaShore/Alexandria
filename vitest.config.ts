import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["tests/unit/setup.ts"],
    include: ["tests/unit/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "tests/unit/web-library*.test.ts"],
    coverage: {
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage"
    }
  }
});


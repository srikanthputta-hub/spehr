import { defineConfig } from "vitest/config";

// Separate from vite.config.ts on purpose: that config wires up nitro's
// cloudflare-module preset and TanStack Start's SSR plugin, neither of which
// belong in (or are needed for) a unit-test run. Keep this minimal.
export default defineConfig({
  resolve: {
    alias: {
      "@": `${process.cwd()}/src`,
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});

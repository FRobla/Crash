import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Bundles the operator crank (and the devnet end-to-end player) into Node ESM files
// (docs/specs/crash-client-v1.md §4.6). Source from `src/` is inlined through the `@/` alias; npm
// dependencies stay external and load from node_modules at run time. Never imported by the web app.
const entry = (file: string) => fileURLToPath(new URL(file, import.meta.url));

export default defineConfig({
  resolve: { tsconfigPaths: true },
  build: {
    ssr: true,
    outDir: entry("./dist"),
    emptyOutDir: true,
    target: "node24",
    sourcemap: false,
    rollupOptions: {
      input: {
        operator: entry("./main.ts"),
        "e2e-player": entry("./e2e-player.ts"),
        "admin-config": entry("./admin-config.ts"),
      },
      output: { entryFileNames: "[name].mjs" },
    },
  },
});

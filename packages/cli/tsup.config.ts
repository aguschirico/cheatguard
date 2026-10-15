import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: true,
  noExternal: ["@cheatguard/core"],
  banner: { js: "#!/usr/bin/env node" },
  esbuildOptions(options) {
    options.alias = {
      "@cheatguard/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    };
  },
});

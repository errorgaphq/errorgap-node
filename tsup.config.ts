import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts", "src/express.ts", "src/fastify.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node20",
    splitting: false,
    treeshake: true,
  },
  {
    // The `errorgap` command line (`npx @errorgap/node …`).
    entry: { cli: "src/bin.ts" },
    format: ["cjs"],
    banner: { js: "#!/usr/bin/env node" },
    target: "node20",
    splitting: false,
  },
]);

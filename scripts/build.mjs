import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "none",
};

// The shipped CLI.
await build({
  ...common,
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  banner: { js: "#!/usr/bin/env node" },
});

// Internal helpers bundle used only by scripts/smoke.mjs (not published).
await build({
  ...common,
  entryPoints: ["src/lib.ts"],
  outfile: "dist/lib.js",
});

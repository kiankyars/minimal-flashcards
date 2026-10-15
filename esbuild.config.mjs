import { build } from "esbuild";
import { readFile } from "node:fs/promises";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  target: "es2022",
  platform: "browser",
  outfile: "main.js",
  minify: true,
    legalComments: "none",
    banner: { js: `/*! ts-fsrs\n${await readFile(new URL("./node_modules/ts-fsrs/LICENSE", import.meta.url), "utf8")}*/` },
});

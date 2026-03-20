import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["plugin-example/src/code.ts"],
  outDir: "plugin-dist",
  format: ["iife"],
  globalName: "FigmaControlWorker",
  platform: "browser",
  target: "es2019",
  bundle: true,
  sourcemap: false,
  clean: true,
  minify: false,
  splitting: false,
  tsconfig: "tsconfig.plugin.json",
  outExtension() {
    return {
      js: ".js"
    };
  }
});

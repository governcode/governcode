// Vite configs for the three pieces: the renderer (React), and the main process and preload
// (each bundled alone to one CommonJS file: a sandboxed preload cannot load shared chunks).
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import type { InlineConfig, Plugin } from "vite";

export const appDir = fileURLToPath(new URL("..", import.meta.url));

// No remote content, ever. Dev adds only what Vite's local hot reload needs.
const CSP_BUILD = "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
const CSP_DEV = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self' ws://localhost:*; object-src 'none'; base-uri 'none'";

function csp(dev: boolean): Plugin {
  return {
    name: "governcode-csp",
    transformIndexHtml: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: dev ? CSP_DEV : CSP_BUILD }, injectTo: "head-prepend" }],
  };
}

export function rendererConfig(dev: boolean): InlineConfig {
  return {
    configFile: false,
    root: join(appDir, "src/renderer"),
    base: "./",
    plugins: [react(), csp(dev)],
    server: { host: "localhost", port: 5174, strictPort: false },
    build: { outDir: join(appDir, "dist/renderer"), emptyOutDir: true, target: "chrome140", assetsInlineLimit: 0 },
    logLevel: "warn",
  };
}

export function nodeConfig(entry: string, name: string): InlineConfig {
  const node = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];
  return {
    configFile: false,
    root: appDir,
    build: {
      outDir: join(appDir, "dist/main"),
      emptyOutDir: false,
      target: "node22",
      minify: false,
      lib: { entry: join(appDir, entry), formats: ["cjs"], fileName: () => `${name}.cjs` },
      rolldownOptions: { external: ["electron", ...node], platform: "node" },
    },
    logLevel: "warn",
  };
}

export const MAIN = ["src/main/main.ts", "main"] as const;
export const PRELOAD = ["src/preload/preload.ts", "preload"] as const;

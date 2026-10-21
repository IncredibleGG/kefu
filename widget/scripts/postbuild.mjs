// 把 demo 頁複製進 dist,讓 nginx 直接把 demo 當首頁提供(/ → demo/index.html)。
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dist = resolve(root, "dist");

if (!existsSync(dist)) mkdirSync(dist, { recursive: true });
copyFileSync(resolve(root, "demo/index.html"), resolve(dist, "index.html"));
console.log("[postbuild] demo/index.html -> dist/index.html");

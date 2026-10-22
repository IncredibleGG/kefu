/**
 * 登入 / 原生 SSO 邏輯的單元測試執行器(不需額外套件:esbuild 由 Vite 附帶,測試用 node:test)。
 * 用法:cd frontend && node src/components/auth/__tests__/run.mjs
 * 以 esbuild 打包 auth.test.mjs(把 @/lib/platform、@/api/client、@/lib/config 換成 stubs/),輸出到系統暫存目錄後執行。
 */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../../..");
const stubs = {
  "@/lib/platform": path.join(here, "stubs/platform.mjs"),
  "@/api/client": path.join(here, "stubs/client.mjs"),
  "@/lib/config": path.join(here, "stubs/config.mjs"),
};
const outDir = mkdtempSync(path.join(tmpdir(), "kefu-auth-test-"));
const outfile = path.join(outDir, "auth.test.mjs");
try {
  await build({
    entryPoints: [path.join(here, "auth.test.mjs")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "error",
    external: ["@capacitor/browser", "i18next"],
    define: { "import.meta.env": "{}" },
    plugins: [
      {
        name: "kefu-alias",
        setup(b) {
          b.onResolve({ filter: /^@\// }, (a) => ({
            path: stubs[a.path] ?? path.join(src, `${a.path.slice(2)}.ts`),
          }));
        },
      },
    ],
  });
  const r = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit" });
  process.exitCode = r.status ?? 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

#!/usr/bin/env node
// 把 clients/branding/brand.json(品牌唯一來源)同步到各原生殼的設定檔。
// 無外部依賴,只用 Node 內建模組;可重複執行(idempotent),內容沒變就不寫檔。
//
// 用法:
//   node clients/scripts/sync-brand.mjs [--version X.Y.Z] [--build N] [--dry-run] [--root <repo 根目錄>]
//
//   --version  版本號,預設 brand.json 的 version。只接受純數字 X.Y.Z
//              (Windows MSI 規定 major/minor ≤ 255、patch ≤ 65535,不接受 -beta 之類的預發行字尾)。
//              可帶前綴 v(例如直接傳 tag 名稱 v0.2.0)。
//   --build    建置序號(Android versionCode、iOS CURRENT_PROJECT_VERSION),預設 1。
//   --dry-run  只列出會改什麼,不寫檔。
//   --root     repo 根目錄,預設為本腳本往上兩層(測試用)。
//
// 會更新的檔案(不存在就警告並跳過;唯一例外是 frontend/.env.native,見下):
//   frontend/src-tauri/tauri.conf.json                 productName、identifier、version
//   frontend/capacitor.config.ts                       appId、appName
//   frontend/android/app/build.gradle                  applicationId、versionName、versionCode
//   frontend/ios/App/App.xcodeproj/project.pbxproj     App target 的 PRODUCT_BUNDLE_IDENTIFIER、MARKETING_VERSION、CURRENT_PROJECT_VERSION
//   frontend/.env.native                               VITE_DEFAULT_SERVER(並確保 VITE_PLATFORM=native、VITE_MOCK=off)
//
// .env.native 已入庫(根目錄 .gitignore 以 `!frontend/.env.native` 放行);保險起見缺檔時仍依契約內容建立,
// 少了它原生版會缺 VITE_MOCK=off(伺服器連不上時會靜默改用假資料)。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// ---------- 參數 ----------

function fail(msg) {
  console.error(`[sync-brand] 錯誤:${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { version: null, build: null, dryRun: false, root: resolve(here, "..", "..") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => {
      const eq = a.indexOf("=");
      if (eq !== -1) return a.slice(eq + 1);
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) fail(`${a} 需要一個值`);
      return v;
    };
    const name = a.split("=")[0];
    switch (name) {
      case "--version":
        out.version = take();
        break;
      case "--build":
        out.build = take();
        break;
      case "--root":
        out.root = resolve(take());
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "-h":
      case "--help":
        console.log(
          "用法:node clients/scripts/sync-brand.mjs [--version X.Y.Z] [--build N] [--dry-run] [--root DIR]",
        );
        process.exit(0);
        break;
      default:
        fail(`未知參數 ${a}`);
    }
  }
  return out;
}

/** MSI(WiX)只接受數字版本:major.minor ≤ 255,patch ≤ 65535 */
function validateVersion(raw) {
  const v = String(raw).trim().replace(/^v/, "");
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(v);
  if (!m) fail(`版本號「${raw}」不合法:只接受純數字 X.Y.Z(MSI 不接受預發行字尾,例如 -beta.1)`);
  const [major, minor, patch] = m.slice(1).map(Number);
  if (major > 255 || minor > 255) fail(`版本號「${v}」不合法:MSI 規定 major 與 minor 最大 255`);
  if (patch > 65535) fail(`版本號「${v}」不合法:MSI 規定 patch 最大 65535`);
  return v;
}

/** Android versionCode 上限 2100000000;iOS CFBundleVersion 用同一個整數 */
function validateBuild(raw) {
  const s = String(raw).trim();
  if (!/^[1-9]\d*$/.test(s)) fail(`建置序號「${raw}」不合法:必須是正整數`);
  const n = Number(s);
  if (n > 2100000000) fail(`建置序號「${raw}」超過 Android versionCode 上限 2100000000`);
  return n;
}

function validateServer(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    fail(`brand.json 的 defaultServer「${raw}」不是合法網址`);
  }
  if (u.protocol !== "https:") fail(`brand.json 的 defaultServer 必須是 https(目前:${raw})`);
  return String(raw).replace(/\/+$/, "");
}

// ---------- 工具 ----------

const results = []; // { file, status, changes: string[] }

/**
 * 對單一檔案做轉換:transform(text) 回傳 { text, changes, warnings }。
 * 內容沒變就不寫;dry-run 時永遠不寫。
 */
function processFile(ctx, relPath, transform, { createIfMissing } = {}) {
  const abs = resolve(ctx.root, relPath);
  let text;
  let created = false;
  if (!existsSync(abs)) {
    if (!createIfMissing) {
      console.warn(`[sync-brand] 警告:找不到 ${relPath},略過`);
      results.push({ file: relPath, status: "略過(檔案不存在)", changes: [] });
      return;
    }
    text = "";
    created = true;
  } else {
    text = readFileSync(abs, "utf8");
  }
  let out;
  try {
    out = transform(text);
  } catch (e) {
    console.warn(`[sync-brand] 警告:${relPath} 無法處理(${e.message}),略過`);
    results.push({ file: relPath, status: "略過(無法解析)", changes: [] });
    return;
  }
  for (const w of out.warnings ?? []) console.warn(`[sync-brand] 警告:${relPath}:${w}`);
  const changed = out.text !== text || created;
  if (changed && !ctx.dryRun) writeFileSync(abs, out.text, "utf8");
  const status = !changed
    ? "未變更"
    : ctx.dryRun
      ? created
        ? "將建立(dry-run)"
        : "將更新(dry-run)"
      : created
        ? "已建立"
        : "已更新";
  results.push({ file: relPath, status, changes: out.changes });
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 取代「恰好出現一次」的 pattern;出現 0 次或多次都不動並回報警告,避免改錯地方。
 * pattern 必須有三個群組:前綴、引號(可為空字串)、舊值。
 */
function replaceOnce(text, pattern, newValue, label, changes, warnings) {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  const matches = [...text.matchAll(global)];
  if (matches.length === 0) {
    warnings.push(`找不到 ${label},未更新`);
    return text;
  }
  if (matches.length > 1) {
    warnings.push(`${label} 出現 ${matches.length} 次,為避免改錯未更新`);
    return text;
  }
  const [, prefix, quote, oldValue] = matches[0];
  if (oldValue === String(newValue)) return text;
  changes.push(`${label}:${oldValue} → ${newValue}`);
  const single = new RegExp(pattern.source, pattern.flags.replace("g", ""));
  return text.replace(single, () => `${prefix}${quote}${newValue}${quote}`);
}

// ---------- 各檔案的轉換 ----------

function syncTauri(brand, version) {
  return (text) => {
    const changes = [];
    const conf = JSON.parse(text);
    const want = { productName: brand.productName, identifier: brand.appId, version };
    for (const [k, v] of Object.entries(want)) {
      if (conf[k] !== v) {
        changes.push(`${k}:${conf[k] ?? "(無)"} → ${v}`);
        conf[k] = v;
      }
    }
    if (!changes.length) return { text, changes };
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    let next = JSON.stringify(conf, null, 2) + "\n";
    if (eol !== "\n") next = next.replace(/\n/g, eol);
    return { text: next, changes };
  };
}

function syncCapacitor(brand) {
  return (text) => {
    const changes = [];
    const warnings = [];
    // 只比對物件屬性形式 appId: "..." / appName: '...',值內不得含引號或換行
    let t = text;
    t = replaceOnce(t, /(\bappId\s*:\s*)(["'`])([^"'`\r\n]*)\2/, brand.appId, "appId", changes, warnings);
    t = replaceOnce(t, /(\bappName\s*:\s*)(["'`])([^"'`\r\n]*)\2/, brand.productName, "appName", changes, warnings);
    return { text: t, changes, warnings };
  };
}

function syncGradle(brand, version, build) {
  return (text) => {
    const changes = [];
    const warnings = [];
    let t = text;
    // 同時支援 Groovy 舊寫法 `applicationId "x"` 與新寫法 `applicationId = "x"`;刻意不動 namespace
    // (namespace 綁定 MainActivity 的 Java package,改了會編不過)
    t = replaceOnce(t, /^(\s*applicationId\s*(?:=\s*)?)(["'])([^"'\r\n]*)\2/m, brand.appId, "applicationId", changes, warnings);
    t = replaceOnce(t, /^(\s*versionName\s*(?:=\s*)?)(["'])([^"'\r\n]*)\2/m, version, "versionName", changes, warnings);
    t = replaceOnce(t, /^(\s*versionCode\s*(?:=\s*)?)()(\d+)\b/m, build, "versionCode", changes, warnings);
    return { text: t, changes, warnings };
  };
}

/** 解析 pbxproj 頂層物件(兩個 tab 縮排、24 碼十六進位 ID) */
function pbxObjects(text) {
  const re = /^\t\t([0-9A-Fa-f]{24})(?: \/\*.*?\*\/)? = \{\r?\n([\s\S]*?)^\t\t\};/gm;
  const objs = new Map();
  for (const m of text.matchAll(re)) {
    objs.set(m[1], { id: m[1], body: m[2], start: m.index, end: m.index + m[0].length, raw: m[0] });
  }
  return objs;
}

function pbxField(body, key) {
  const m = new RegExp(`^\\t\\t\\t${escapeRegExp(key)} = ("(?:[^"\\\\]|\\\\.)*"|[^;\\r\\n]*);`, "m").exec(body);
  if (!m) return null;
  return m[1].replace(/^"(.*)"$/, "$1");
}

function syncPbxproj(brand, version, build) {
  return (text) => {
    const changes = [];
    const warnings = [];
    const objs = pbxObjects(text);
    const apps = [...objs.values()].filter(
      (o) =>
        pbxField(o.body, "isa") === "PBXNativeTarget" &&
        pbxField(o.body, "productType") === "com.apple.product-type.application",
    );
    // 優先選名為 App 的 target(Capacitor 範本),否則只有一個 application target 時用它
    const target = apps.find((o) => pbxField(o.body, "name") === "App") ?? (apps.length === 1 ? apps[0] : null);
    if (!target) throw new Error("找不到 App target(PBXNativeTarget,productType=application)");
    const listId = /buildConfigurationList = ([0-9A-Fa-f]{24})/.exec(target.body)?.[1];
    const list = listId ? objs.get(listId) : null;
    if (!list) throw new Error("找不到 App target 的 buildConfigurationList");
    const configIds = [...(/buildConfigurations = \(([\s\S]*?)\);/.exec(list.body)?.[1] ?? "").matchAll(/([0-9A-Fa-f]{24})/g)].map(
      (m) => m[1],
    );
    if (!configIds.length) throw new Error("App target 沒有任何 build configuration");

    const want = {
      PRODUCT_BUNDLE_IDENTIFIER: brand.appId,
      MARKETING_VERSION: version,
      CURRENT_PROJECT_VERSION: String(build),
    };
    // 由後往前替換,前面物件的位置才不會位移
    const configs = configIds
      .map((id) => objs.get(id))
      .filter(Boolean)
      .sort((a, b) => b.start - a.start);
    let t = text;
    for (const cfg of configs) {
      const cfgName = pbxField(cfg.body, "name") ?? cfg.id;
      let raw = cfg.raw;
      for (const [key, value] of Object.entries(want)) {
        const re = new RegExp(`^(\\t+)${key} = ("(?:[^"\\\\]|\\\\.)*"|[^;\\r\\n]*);`, "m");
        const m = re.exec(raw);
        if (m) {
          const old = m[2].replace(/^"(.*)"$/, "$1");
          if (old !== value) {
            raw = raw.replace(re, () => `${m[1]}${key} = ${value};`);
            changes.push(`[${cfgName}] ${key}:${old} → ${value}`);
          }
        } else {
          const bs = /^(\t+)buildSettings = \{\r?\n/m.exec(raw);
          if (!bs) {
            warnings.push(`[${cfgName}] 沒有 buildSettings,無法加入 ${key}`);
            continue;
          }
          const eol = bs[0].endsWith("\r\n") ? "\r\n" : "\n";
          const insertAt = bs.index + bs[0].length;
          raw = raw.slice(0, insertAt) + `${bs[1]}\t${key} = ${value};${eol}` + raw.slice(insertAt);
          changes.push(`[${cfgName}] ${key}:(無) → ${value}`);
        }
      }
      t = t.slice(0, cfg.start) + raw + t.slice(cfg.end);
    }
    return { text: t, changes, warnings };
  };
}

function syncEnvNative(server) {
  return (text) => {
    const changes = [];
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/);
    // 契約(NATIVE-CLIENTS.md §3):VITE_MOCK 必須為 off
    const want = [
      ["VITE_PLATFORM", "native"],
      ["VITE_MOCK", "off"],
      ["VITE_DEFAULT_SERVER", server],
    ];
    for (const [key, value] of want) {
      const idx = lines.findIndex((l) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(l));
      if (idx === -1) {
        lines.push(`${key}=${value}`);
        changes.push(`${key}:(無) → ${value}`);
        continue;
      }
      const old = lines[idx].replace(/^[^=]*=\s*/, "").replace(/^(["'])(.*)\1\s*$/, "$2").trim();
      if (old !== value) {
        lines[idx] = `${key}=${value}`;
        changes.push(`${key}:${old} → ${value}`);
      }
    }
    if (!changes.length) return { text, changes };
    if (text === "") lines.unshift("# 原生建置環境(由 clients/scripts/sync-brand.mjs 產生;契約見 docs/NATIVE-CLIENTS.md §3)");
    return { text: lines.join(eol) + eol, changes };
  };
}

// ---------- 主程式 ----------

const args = parseArgs(process.argv.slice(2));
const brandPath = resolve(args.root, "clients/branding/brand.json");
if (!existsSync(brandPath)) fail(`找不到 ${relative(process.cwd(), brandPath) || brandPath}`);
let brand;
try {
  brand = JSON.parse(readFileSync(brandPath, "utf8"));
} catch (e) {
  fail(`brand.json 解析失敗:${e.message}`);
}
for (const k of ["productName", "appId", "version", "defaultServer"]) {
  if (typeof brand[k] !== "string" || !brand[k]) fail(`brand.json 缺少 ${k}`);
}
// Android 規定 applicationId 每段需字母開頭;iOS bundle id 只接受英數、-、.
if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(brand.appId)) {
  fail(`brand.json 的 appId「${brand.appId}」不合法(每段需字母開頭,只能含英數與底線)`);
}
if (!/^[^"'`\\\r\n]+$/.test(brand.productName)) fail(`brand.json 的 productName 含不允許的字元`);

const version = validateVersion(args.version ?? brand.version);
const build = validateBuild(args.build ?? 1);
const server = validateServer(brand.defaultServer);
const ctx = { root: args.root, dryRun: args.dryRun };

processFile(ctx, "frontend/src-tauri/tauri.conf.json", syncTauri(brand, version));
processFile(ctx, "frontend/capacitor.config.ts", syncCapacitor(brand));
processFile(ctx, "frontend/android/app/build.gradle", syncGradle(brand, version, build));
processFile(ctx, "frontend/ios/App/App.xcodeproj/project.pbxproj", syncPbxproj(brand, version, build));
processFile(ctx, "frontend/.env.native", syncEnvNative(server), { createIfMissing: true });

console.log(
  `[sync-brand] ${brand.productName}(${brand.appId})版本 ${version},建置序號 ${build}${args.dryRun ? ",dry-run 不寫檔" : ""}`,
);
for (const r of results) {
  console.log(`  - ${r.file}:${r.status}`);
  for (const c of r.changes) console.log(`      ${c}`);
}

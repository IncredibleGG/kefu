// kefu 桌面版(Tauri 2,Windows)登入 E2E:伺服器設定 → 登入 → 工作台。
// 需要先啟動 tauri-driver(預設 http://127.0.0.1:4444),它再用 msedgedriver 驅動 WebView2。
// 環境變數:
//   KEFU_EXE      已安裝的 kefu.exe 絕對路徑(必填)
//   E2E_SERVER    伺服器網址(空白時用 https://kf.56k.cc)
//   E2E_EMAIL     坐席帳號(必填)
//   E2E_PASSWORD  密碼(必填)
//   E2E_OUT       截圖與記錄輸出目錄(預設 ./e2e-out)
//   WEBDRIVER_URL tauri-driver 位址(預設 http://127.0.0.1:4444/)
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Builder, By, Capabilities, Key, until } from "selenium-webdriver";

const DEFAULT_SERVER = "https://kf.56k.cc";
const exe = process.env.KEFU_EXE;
const server = (process.env.E2E_SERVER || DEFAULT_SERVER).trim();
const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;
const out = path.resolve(process.env.E2E_OUT || "e2e-out");
const webdriverUrl = process.env.WEBDRIVER_URL || "http://127.0.0.1:4444/";

if (!exe || !email || !password) {
  console.error("缺少 KEFU_EXE / E2E_EMAIL / E2E_PASSWORD");
  process.exit(2);
}

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

async function shot(driver, name) {
  const png = await driver.takeScreenshot();
  const file = path.join(out, `${name}.png`);
  await writeFile(file, png, "base64");
  log("截圖", file);
}

async function snapshot(driver, name) {
  // 失敗時留下 DOM 與目前網址,方便調整選擇器(上傳前會遮蔽帳密)
  try {
    const url = await driver.getCurrentUrl();
    const html = await driver.getPageSource();
    await writeFile(path.join(out, `${name}.html`), `<!-- ${url} -->\n${html}`);
  } catch (e) {
    log("無法取得 DOM:", e.message);
  }
}

/** 等待元素出現且可見 */
async function visible(driver, css, timeout) {
  const el = await driver.wait(until.elementLocated(By.css(css)), timeout, `等不到 ${css}`);
  await driver.wait(until.elementIsVisible(el), timeout, `${css} 不可見`);
  return el;
}

/** React 受控輸入框:全選刪除再輸入(el.clear() 不會觸發 React onChange) */
async function typeInto(el, text) {
  await el.click();
  await el.sendKeys(Key.CONTROL, "a");
  await el.sendKeys(Key.BACK_SPACE);
  await el.sendKeys(text);
}

async function pathname(driver) {
  return new URL(await driver.getCurrentUrl()).pathname;
}

async function main() {
  await mkdir(out, { recursive: true });
  const caps = new Capabilities();
  if (process.env.WEBDRIVER_MODE === "attach") {
    // 附加到已啟動、開了 --remote-debugging-port 的 kefu.exe(WebView2),由 msedgedriver 直接驅動
    caps.setBrowserName("webview2");
    caps.set("ms:edgeChromium", true);
    caps.set("ms:edgeOptions", { debuggerAddress: process.env.DEBUGGER_ADDRESS || "127.0.0.1:9222" });
  } else if (process.env.WEBDRIVER_MODE === "edgedriver") {
    // 診斷用:不經 tauri-driver,直接對 msedgedriver 下 WebView2 capabilities
    caps.setBrowserName("webview2");
    caps.set("ms:edgeChromium", true);
    caps.set("ms:edgeOptions", { binary: exe, args: [], webviewOptions: {} });
  } else {
    caps.setBrowserName("wry");
    caps.set("tauri:options", { application: exe });
  }
  log("啟動", exe, "via", webdriverUrl);
  const driver = await new Builder().withCapabilities(caps).usingServer(webdriverUrl).build();
  let step = "init";
  try {
    // ---------- 1. 伺服器設定頁 ----------
    step = "setup";
    const urlInput = await visible(driver, "#server-url", 90_000);
    await shot(driver, "01-setup");
    const prefilled = await urlInput.getAttribute("value");
    log("預填伺服器:", prefilled);
    if (prefilled.replace(/\/+$/, "") !== server.replace(/\/+$/, "")) {
      await typeInto(urlInput, server);
    }
    await (await driver.findElement(By.css("form button[type='submit']"))).click();

    // ---------- 2. 登入頁 ----------
    step = "login";
    const emailInput = await visible(driver, "input#email[type='email']", 60_000);
    const pwInput = await visible(driver, "input#password[type='password']", 10_000);
    await shot(driver, "02-login");
    await typeInto(emailInput, email);
    await typeInto(pwInput, password);
    await shot(driver, "03-login-filled");
    await (await driver.findElement(By.css("form button[type='submit']"))).click();

    // ---------- 3. 登入後 ----------
    step = "after-login";
    // 管理員 / 主管落在 /dashboard,坐席落在 /workspace;登入失敗時表單會出現 role=alert
    await driver.wait(
      async () => {
        const p = await pathname(driver);
        if (p.startsWith("/workspace") || p.startsWith("/dashboard")) return true;
        const alerts = await driver.findElements(By.css("form [role='alert']"));
        for (const a of alerts) {
          const text = (await a.getText()).trim();
          if (text) throw new Error(`登入失敗:${text}`);
        }
        return false;
      },
      90_000,
      "登入後沒有進入 /workspace 或 /dashboard",
    );
    log("登入後頁面:", await pathname(driver));
    await driver.sleep(2000);
    await shot(driver, "04-after-login");

    // ---------- 4. 工作台 ----------
    step = "workspace";
    if (!(await pathname(driver)).startsWith("/workspace")) {
      const link = await visible(driver, "a[href='/workspace']", 30_000);
      await link.click();
      await driver.wait(async () => (await pathname(driver)).startsWith("/workspace"), 30_000, "沒有切到 /workspace");
    }
    // 會話清單的四個分頁(我的 / 未分配 / 佇列 / 在線)
    await driver.wait(
      async () => (await driver.findElements(By.css("[role='tablist'] [role='tab']"))).length >= 4,
      60_000,
      "工作台分頁沒有出現",
    );
    const tabs = await driver.findElements(By.css("[role='tablist'] [role='tab']"));
    const labels = [];
    for (const tb of tabs) labels.push((await tb.getText()).trim());
    log("工作台分頁:", labels.join(" / "));
    await driver.sleep(3000); // 等清單載入
    await shot(driver, "05-workspace");
    await writeFile(path.join(out, "result.json"), JSON.stringify({ ok: true, path: await pathname(driver), tabs: labels }, null, 2));
    log("完成");
  } catch (e) {
    log(`失敗(${step}):`, e.message);
    await shot(driver, `failure-${step}`).catch(() => undefined);
    await snapshot(driver, `failure-${step}`);
    await writeFile(path.join(out, "result.json"), JSON.stringify({ ok: false, step, error: e.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await driver.quit().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

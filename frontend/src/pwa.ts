/**
 * PWA 前端整合(獨立入口,由 index.html 以 <script type="module"> 掛載)。
 *
 * 職責:
 *  1. 註冊 Service Worker(/sw.js)。
 *  2. 捕捉 `beforeinstallprompt`,提供一個「自帶」的浮動「安裝到桌面」按鈕
 *     —— 純 DOM 生成,不依賴任何既有元件或 React 樹,故不需改動 main.tsx。
 *  3. 已安裝 / 不可安裝時自動隱藏按鈕。
 *
 * 設計:避免污染全域樣式,按鈕全部用 inline style;品牌紫直接寫死 #6d5efc。
 */

// `beforeinstallprompt` 尚未進標準 TS DOM lib,自行宣告最小型別。
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt: () => Promise<void>;
}

const BRAND = "#6d5efc";
const DISMISS_KEY = "kefu-pwa-install-dismissed";

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let installBtn: HTMLButtonElement | null = null;

/** 是否已在獨立視窗(已安裝)執行 */
function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    // iOS Safari
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function userDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function createInstallButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("aria-label", "安裝 kefu 坐席台到桌面");
  btn.textContent = "安裝到桌面";
  Object.assign(btn.style, {
    position: "fixed",
    right: "16px",
    bottom: "16px",
    zIndex: "2147483000",
    display: "none",
    alignItems: "center",
    gap: "8px",
    padding: "10px 16px",
    border: "none",
    borderRadius: "10px",
    background: BRAND,
    color: "#fff",
    font: '600 13px/1.2 "Inter", system-ui, -apple-system, "PingFang TC", "Noto Sans TC", sans-serif',
    boxShadow: "0 8px 24px rgba(109,94,252,0.38)",
    cursor: "pointer",
    transition: "transform .15s ease, box-shadow .15s ease",
  } as CSSStyleDeclaration);

  // 前置一個下載小圖示(inline SVG)
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "16");
  icon.setAttribute("height", "16");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.style.marginRight = "6px";
  icon.style.verticalAlign = "-3px";
  icon.innerHTML =
    '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>';
  btn.prepend(icon);

  btn.addEventListener("mouseenter", () => {
    btn.style.transform = "translateY(-1px)";
    btn.style.boxShadow = "0 10px 28px rgba(109,94,252,0.5)";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.transform = "none";
    btn.style.boxShadow = "0 8px 24px rgba(109,94,252,0.38)";
  });

  btn.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    btn.style.display = "none";
    await deferredPrompt.prompt();
    try {
      await deferredPrompt.userChoice;
    } catch {
      /* 使用者取消,無需處理 */
    }
    deferredPrompt = null; // prompt 只能用一次
  });

  return btn;
}

function showInstallButton() {
  if (isStandalone() || userDismissed()) return;
  if (!installBtn) {
    installBtn = createInstallButton();
    document.body.appendChild(installBtn);
  }
  installBtn.style.display = "inline-flex";
}

function hideInstallButton() {
  if (installBtn) installBtn.style.display = "none";
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("[pwa] SW 註冊失敗:", err);
    });
  });
}

export function initPwa() {
  registerServiceWorker();

  window.addEventListener("beforeinstallprompt", (e) => {
    // 攔截瀏覽器預設迷你資訊列,改用自家按鈕
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    showInstallButton();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    hideInstallButton();
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* 忽略 storage 不可用 */
    }
  });
}

// 作為 index.html 的獨立入口:載入即初始化。
initPwa();

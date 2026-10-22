/// <reference types="@capacitor/splash-screen" />
/// <reference types="@capacitor/keyboard" />
/// <reference types="@capacitor/push-notifications" />
/// <reference types="@capacitor/local-notifications" />
/// <reference types="@capacitor/status-bar" />
import type { CapacitorConfig } from "@capacitor/cli";
import type { KeyboardResize } from "@capacitor/keyboard";

// Capacitor(iOS / Android)設定。品牌常數來自 clients/branding/brand.json,
// 介面與常數以 docs/NATIVE-CLIENTS.md 為準。
//
// 注意:刻意「不設」server.hostname / iosScheme / androidScheme,沿用預設
//   iOS  → capacitor://localhost
//   Android → https://localhost
// 這兩個 origin 上線後不可更改(改了 localStorage 會整個找不回來,後端 CORS 白名單也綁定它們)。

/** 品牌主色(brand.json primaryColor) */
const BRAND_PRIMARY = "#7c5cff";
/** 啟動畫面底色(brand.json backgroundColor) */
const BRAND_BACKGROUND = "#ffffff";

const config: CapacitorConfig = {
  appId: "cc.kf56k.kefu",
  appName: "kefu",
  // 與 Tauri frontendDist 共用:npm run build:native 產出
  webDir: "dist-native",
  server: {
    // Android WebView 版本低於 minWebViewVersion 時改載入此頁(提示更新 WebView);
    // 檔案由 public/webview-too-old.html 帶進 dist-native。iOS 主框架載入失敗時也會顯示它。
    errorPath: "webview-too-old.html",
  },
  android: {
    // Tailwind v4 需要 Chrome 111+
    minWebViewVersion: 111,
    // https://localhost 頁面內禁止載入 http 資源(只接受 https 伺服器)
    allowMixedContent: false,
  },
  ios: {
    // 讓 CSS env(safe-area-inset-*) 生效,由前端自行留白
    contentInset: "never",
  },
  plugins: {
    SplashScreen: {
      // App 第一次 render 完成後由前端呼叫 SplashScreen.hide()
      launchAutoHide: false,
      backgroundColor: BRAND_BACKGROUND,
      androidScaleType: "CENTER_CROP",
      showSpinner: false,
    },
    Keyboard: {
      // 以原生方式縮放 WebView,輸入框不會被鍵盤蓋住
      resize: "native" as KeyboardResize,
      resizeOnFullScreen: true,
    },
    PushNotifications: {
      // 前景收到推播時(iOS)仍顯示橫幅 / 聲音 / 角標
      presentationOptions: ["badge", "sound", "alert"],
    },
    LocalNotifications: {
      // res/drawable/ic_stat_kefu.xml(白色對話泡泡剪影)
      smallIcon: "ic_stat_kefu",
      iconColor: BRAND_PRIMARY,
    },
    StatusBar: {
      // 內容延伸到狀態列下方,改用 CSS safe-area insets 留白
      overlaysWebView: true,
    },
    SystemBars: {
      // Capacitor 8 預設值:注入 --safe-area-inset-* CSS 變數(Android)
      insetsHandling: "css",
    },
  },
};

export default config;

# kefu 原生 App 登入 E2E

驗證「全新安裝 → 伺服器設定 → 帳密登入 → 坐席工作台」整條路徑在真的 App 殼裡跑得通。
CI 上每個平台各一個 job,**`continue-on-error: true`,不擋建置與發佈**。

| 平台 | Workflow / job | 工具 | 產物(artifact) |
|---|---|---|---|
| Android | `android.yml` → `e2e-android` | [Maestro](https://maestro.dev) + `reactivecircus/android-emulator-runner`(API 34、x86_64) | `e2e-android` |
| iOS | `ios.yml` → `e2e-ios` | Maestro + `macos-latest` 上的 iPhone 模擬器(最新 iOS runtime) | `e2e-ios` |
| Windows | `desktop.yml` → `e2e-windows` | CI 另建的 E2E 專用版(App 自開 DevTools 埠 9222,不發佈)+ 與 WebView2 同版的 `msedgedriver` 附加 + `selenium-webdriver`(原因見下方「Windows 已知限制」) | `e2e-windows` |
| macOS | — | **不支援**:WKWebView 沒有 WebDriver 實作(`tauri-driver` 只支援 Windows / Linux),只保留 `smoke-macos` 啟動截圖 | — |

每個 job 都依賴同一個 workflow 的建置 job,安裝**剛建好的**產物(Android debug APK、iOS 模擬器版 `App.app`、Windows NSIS 安裝檔靜默安裝),
跑完上傳截圖與工具記錄。

## 帳密

Repository secrets(**值不可寫進檔案或印到記錄**):

| Secret | 用途 |
|---|---|
| `E2E_SERVER` | 伺服器網址;空白時用 App 預填的 `https://kf.56k.cc` |
| `E2E_EMAIL` | 測試坐席帳號 |
| `E2E_PASSWORD` | 密碼 |

沒有 `E2E_EMAIL` / `E2E_PASSWORD`(例如 fork 發的 PR)時 job 直接跳過。

**repo 是公開的,artifact 任何登入 GitHub 的人都能下載。**上傳前 `e2e/scripts/redact.py`:

- 刪除會逐字或拆段記下輸入內容的原始記錄(`msedgedriver*.log`、`xctest_runner*.log`、`device-xctest.log`、
  `device-simulator.log`);`msedgedriver` 的記錄本來就寫在 runner 暫存目錄,不進 artifact。
- 其餘非圖片檔以位元組處理,遮蔽帳號與密碼每一段長度 ≥ 一半(至少 4)的子字串(含 UTF-16、JSON、URL 編碼);
  處理不了的檔案直接刪除。
- 遮蔽步驟沒有成功跑完,upload 步驟就不執行。

截圖不經遮蔽:不截「已填表單」;失敗時的截圖仍可能看到輸入中的帳號(密碼框是遮罩)。artifact 只保留 7 天,
請只用專門的測試帳號。Android 的 E2E job 只還原模擬器快取、不存(登入後的 AVD 含 App 的登入 token)。

## 流程與截圖

| 檔名 | 畫面 |
|---|---|
| `01-setup.png` | 伺服器設定頁(網址框、「測試連線」/「繼續」) |
| `02-login.png` | 登入頁(空白) |
| `04-after-login.png` | 登入後第一個畫面(管理員 / 主管是「總覽」,坐席是「工作台」) |
| `05-workspace.png` | 坐席工作台(會話清單分頁「我的 / 未分配 / 佇列 / 在線」)— **判定成功的畫面** |
| `failure-*.png` / `failure-*.html` / `failure-hierarchy.json` | 失敗時的畫面與 DOM / 元件樹,用來調整選擇器 |

Maestro 的截圖統一收進 artifact 的 `screenshots/`(只放最後一次嘗試的;每次嘗試的完整記錄在 `attempt-N/`)。
模擬器偶發 `Device server died` 這類基礎設施問題時 `run.sh` 會自動重跑(預設共 2 次,CI 上 Android / iOS 各 3 次;`E2E_ATTEMPTS` 可調)。
桌面版截圖直接放在 artifact 根目錄。

## 檔案

```
e2e/
├── maestro/
│   ├── run.sh                   # CI 入口:跑 login.yaml(失敗重跑一次)、收截圖到 screenshots/
│   ├── login.yaml               # Android / iOS 共用主流程
│   ├── common/set-server.yaml   # E2E_SERVER 與預填值不同時改網址
│   ├── android/
│   │   ├── submit-login.yaml    # 收鍵盤 + 點「登入」
│   │   └── wait-setup.yaml      # 等設定頁:關掉模擬器系統程式的 ANR 框;App 行程被系統誤殺時重啟
│   └── ios/
│       ├── submit-login.yaml    # 密碼框按 Enter 送出(WKWebView 收鍵盤不穩)
│       └── dismiss-alerts.yaml  # 系統權限詢問一律允許
├── desktop/
│   ├── login.mjs                # selenium-webdriver,經 tauri-driver 驅動 kefu.exe(另有附加模式)
│   ├── run-windows.ps1          # CI 入口:有 KEFU_E2E_BUILTIN_PORT 時直接附加 E2E 專用版(模式 0);
│   │                            #   否則 tauri-driver → 附加模式 → 對照組
│   ├── webview2-probe.ps1       # 對照組:用官方 WebView2 SDK 開最小宿主,檢查覆寫參數是否生效
│   └── package.json / package-lock.json
└── scripts/redact.py            # 上傳前遮蔽帳密、刪除原始驅動記錄(失敗則不上傳)
```

選擇器以畫面文字為主(App 預設語系是繁體中文),點 `<label>` 聚焦對應輸入框;
桌面版用 CSS:`#server-url`、`#email`、`#password`、`form button[type=submit]`、`a[href="/workspace"]`、`[role=tablist] [role=tab]`。
改了這些頁面(`ServerSetupPage.tsx`、`LoginPage.tsx`、`ConversationList.tsx`、底部分頁列 / 側欄)的文字或結構時,記得同步改這裡。

## Windows 已知限制(2026-10)

`windows-latest` 上的 WebView2 Runtime(實測 154.0.4258.62、155.0.4283.62)**不採用**
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 環境變數,也不採用
`HKCU\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments` 登錄覆寫;
`msedgedriver`(以及包著它的 `tauri-driver`)正是靠這個環境變數把 `--remote-debugging-port` 塞給 WebView2,
所以 browser 行程永遠沒有 DevTools 埠,建立 session 時固定回
`session not created: DevToolsActivePort file doesn't exist`。

`e2e-windows` 每次都會留下證據(artifact `e2e-windows`):

- `processes.log` / `test.log`:browser 行程命令列只有 App 自己傳的 `--disable-features=…`,
  環境變數裡的 `--remote-debugging-port`、`--disable-sync` 等完全沒出現(`--user-data-dir` 覆寫倒是有生效)。
- `webview2-probe.log`:對照組(官方 Microsoft.Web.WebView2 SDK 寫的最小宿主,不是 kefu):
  不帶 / 帶 AdditionalBrowserArguments 時環境變數同樣無效;**由宿主自己在 options 傳 `--remote-debugging-port` 則立即可用**。

也就是說這不是 kefu 的 bug,而是 runtime 端的行為;要在 CI 跑 Windows E2E 只能讓 App 自己開 DevTools 埠,例如:

1. 另建一份**僅供 E2E** 的 Windows 安裝檔:`tauri build --config <覆寫檔>`,在主視窗設定
   `additionalBrowserArgs: "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port=9222"`
   (覆寫會取代整個 `windows` 陣列,需完整複製主視窗設定),再用 `run-windows.ps1` 的附加模式跑;或
2. 在 App 原始碼加「只在特定環境變數存在時」才附加 `--remote-debugging-port` 的 opt-in(需改 `src-tauri`)。

**目前採用做法 1**:`e2e-windows` 自己建一份 E2E 專用版(只在這個 job 裡用,不上傳、不發佈;正式安裝檔不受影響),
設定 `KEFU_E2E_BUILTIN_PORT=9222`,`run-windows.ps1` 走模式 0 直接附加。沒有這個環境變數時腳本仍照舊先試
tauri-driver,runtime 若恢復採用環境變數,標準路徑也能通過。

## 在本機跑

### Android / iOS(Maestro)

```bash
curl -fsSL https://get.maestro.mobile.dev | bash      # 需要 Java 17+
# Android:開好模擬器並 adb install -r -g kefu-android-debug.apk
# iOS:xcrun simctl boot <udid> && xcrun simctl install <udid> App.app
export E2E_SERVER=https://kf.56k.cc E2E_EMAIL=... E2E_PASSWORD=...
bash e2e/maestro/run.sh ./e2e-out                    # iOS 可加:--device <UDID>
# 或直接:maestro test -e E2E_SERVER=… -e E2E_EMAIL=… -e E2E_PASSWORD=… e2e/maestro/login.yaml
```

`launchApp` 帶 `clearState: true`,每次都從伺服器設定頁開始(會清掉 App 已存的伺服器與登入狀態)。
找不到元素時用 `maestro hierarchy` 看 WebView 暴露出來的元件樹。

### Windows(tauri-driver)

```powershell
cargo install tauri-driver --locked
# 下載與 WebView2 Runtime 同版的 msedgedriver:
#   https://msedgedriver.microsoft.com/<版本>/edgedriver_win64.zip
#   版本看登錄 HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5} 的 pv
tauri-driver --port 4444 --native-driver C:\path\to\msedgedriver.exe
# 另一個終端:
cd e2e/desktop; npm ci
$env:KEFU_EXE = "$env:LOCALAPPDATA\kefu\kefu.exe"
$env:E2E_EMAIL = '...'; $env:E2E_PASSWORD = '...'
node login.mjs     # 截圖寫到 .\e2e-out\
```

注意:App 設定(`kefu.json`)與 WebView2 資料在 `%APPDATA%\cc.kf56k.kefu`、`%LOCALAPPDATA%\cc.kf56k.kefu`;已經設定過伺服器或登入過時不會出現設定頁,先刪掉這兩個目錄再跑。

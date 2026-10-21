# clients/scripts

## sync-brand.mjs

把品牌唯一來源 `clients/branding/brand.json` 同步到各原生殼的設定檔。純 Node(≥ 22)、無外部依賴,可重複執行:內容已經一致時不會寫檔。CI(`desktop.yml`、`android.yml`、`ios.yml`、`ci.yml`)每次建置前都會跑。

```bash
node clients/scripts/sync-brand.mjs                          # 版本用 brand.json 的 version,建置序號 1
node clients/scripts/sync-brand.mjs --version 0.2.0 --build 57
node clients/scripts/sync-brand.mjs --dry-run                # 只列出會改什麼
```

| 參數 | 預設 | 說明 |
|---|---|---|
| `--version X.Y.Z` | `brand.json` 的 `version` | 只接受純數字(Windows MSI 規定 major、minor ≤ 255,patch ≤ 65535,不接受 `-beta.1` 之類的字尾)。可帶前綴 `v` |
| `--build N` | `1` | 正整數(≤ 2100000000)。用在 Android `versionCode` 與 iOS `CURRENT_PROJECT_VERSION`;CI 傳 `github.run_number` |
| `--dry-run` | 關 | 不寫檔,只印出差異 |
| `--root DIR` | 本腳本往上兩層 | repo 根目錄,測試用 |

### 會改的檔案

| 檔案 | 欄位 |
|---|---|
| `frontend/src-tauri/tauri.conf.json` | `productName`、`identifier`、`version` |
| `frontend/capacitor.config.ts` | `appId`、`appName`(只取代 `appId: "…"` 形式且恰好出現一次的屬性) |
| `frontend/android/app/build.gradle` | `applicationId`、`versionName`、`versionCode`(**不動** `namespace`,它綁定 MainActivity 的 Java package) |
| `frontend/ios/App/App.xcodeproj/project.pbxproj` | 只改 **App target** 各 build configuration 的 `PRODUCT_BUNDLE_IDENTIFIER`、`MARKETING_VERSION`、`CURRENT_PROJECT_VERSION`(其他 target,例如日後的通知擴充,不受影響) |
| `frontend/.env.native` | `VITE_DEFAULT_SERVER`;並確保 `VITE_PLATFORM=native`、`VITE_MOCK=off` |

- 檔案不存在時印警告並略過,不會失敗。
- 例外:`frontend/.env.native` 被根目錄 `.gitignore` 的 `.env.*` 擋掉,CI checkout 後不存在,所以缺檔時會依 `docs/NATIVE-CLIENTS.md` §3 的內容建立(少了 `VITE_MOCK=off`,伺服器連不上時會靜默改用假資料)。
- 某個欄位找不到或出現多次時,只印警告、不動那個欄位,避免改錯地方。
- `brand.json` 的 `appId` 需每段字母開頭(Android 規定);`defaultServer` 必須是 `https://`。

### CI 的版本規則

推 `v*` tag 時,版本號取自 tag:去掉前綴 `v` 與 `-`/`+` 之後的字尾(`v0.2.0-beta.1` → `0.2.0`);其他情況用 `brand.json` 的 `version`。建置序號一律是該次 workflow 的 `github.run_number`(被 `release.yml` 呼叫時是 release 那次的 run number)。

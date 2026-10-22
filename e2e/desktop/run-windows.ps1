# kefu 桌面版 Windows E2E 執行腳本(CI 的 e2e-windows job 呼叫;本機也可用)。
# 需要的環境變數:KEFU_EXE、MSEDGEDRIVER、E2E_EMAIL、E2E_PASSWORD(E2E_SERVER 選填)、E2E_OUT
# 選填:TAURI_DRIVER(tauri-driver.exe 路徑,預設 ~/.cargo/bin/tauri-driver.exe)
#
# 1. 先走標準路徑:tauri-driver → msedgedriver → 由 msedgedriver 啟動 kefu.exe。
# 2. 若連 session 都建不起來(WebView2 沒開 DevTools 埠,msedgedriver 回 "DevToolsActivePort file doesn't exist"),
#    改用附加模式:自己帶 --remote-debugging-port 啟動 kefu.exe(先試 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
#    環境變數,不行再試 WebView2 的登錄覆寫),再讓 msedgedriver 以 debuggerAddress 附加上去。
# 3. 兩者都失敗時跑 webview2-probe.ps1 對照組,並在 job 上留下 warning。
#
# 已知限制(2026-10,windows-latest、WebView2 Runtime 154/155):runtime 不採用 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
# 與登錄覆寫(連官方 SDK 寫的最小宿主也一樣),只接受宿主程式自己在 environment options 傳入的參數,
# 所以 msedgedriver / tauri-driver 無法讓 kefu.exe 開 DevTools 埠。證據與可行解法見 e2e/README.md。
$ErrorActionPreference = 'Continue'
$out = $env:E2E_OUT
New-Item -ItemType Directory -Force $out | Out-Null
$testLog = Join-Path $out 'test.log'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$login = Join-Path $here 'login.mjs'
$tauriDriver = if ($env:TAURI_DRIVER) { $env:TAURI_DRIVER } else { Join-Path $env:USERPROFILE '.cargo\bin\tauri-driver.exe' }

function Note($msg) { "[$(Get-Date -Format o)] $msg" | Tee-Object -FilePath $testLog -Append }

# msedgedriver 的記錄會逐字記下輸入的帳密(TypeElement 的 value 陣列、每個 Input.dispatchKeyEvent),
# 不可放進會上傳成公開 artifact 的 $out;只留在 runner 的暫存目錄
$driverLog = Join-Path ([System.IO.Path]::GetTempPath()) 'kefu-msedgedriver.log'
function Start-EdgeDriver {
  Start-Process -FilePath $env:MSEDGEDRIVER -ArgumentList '--port=9515', "--log-path=$driverLog" -PassThru
}

function Stop-Kefu {
  Get-Process kefu, msedgedriver -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

function Reset-AppData {
  # 清掉已存的伺服器 / 登入狀態,確保從伺服器設定頁開始
  foreach ($d in (Join-Path $env:LOCALAPPDATA 'cc.kf56k.kefu'), (Join-Path $env:APPDATA 'cc.kf56k.kefu')) {
    Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue
  }
}

function Test-DevTools($port) {
  for ($i = 0; $i -lt 20; $i++) {
    try {
      $v = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2
      Note "DevTools 埠 $port 已開:$($v.Browser)"
      return $true
    } catch { Start-Sleep -Seconds 1 }
  }
  return $false
}

function Run-Login($mode, $url) {
  $env:WEBDRIVER_MODE = $mode
  $env:WEBDRIVER_URL = $url
  node $login 2>&1 | Tee-Object -FilePath $testLog -Append
  return $LASTEXITCODE
}

# ---------- 診斷:WebView2 / Edge 相關原則與權限 ----------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Note "目前身分:$([Security.Principal.WindowsIdentity]::GetCurrent().Name) 管理員=$isAdmin"
foreach ($k in 'HKLM:\SOFTWARE\Policies\Microsoft\Edge', 'HKLM:\SOFTWARE\Policies\Microsoft\Edge\WebView2',
               'HKCU:\Software\Policies\Microsoft\Edge', 'HKCU:\Software\Policies\Microsoft\Edge\WebView2',
               'HKLM:\SOFTWARE\Policies\Microsoft\EdgeUpdate') {
  if (Test-Path $k) {
    Note "原則 $k"
    Get-ChildItem $k -Recurse -ErrorAction SilentlyContinue | ForEach-Object { Note "  子鍵 $($_.Name)" }
    (Get-ItemProperty $k -ErrorAction SilentlyContinue | Out-String).Trim() -split "`n" | ForEach-Object { Note "  $_" }
  }
}

# ---------- 0. E2E 專用版:App 自己開 DevTools 埠 ----------
# CI 以 `tauri build --config` 覆寫主視窗 additionalBrowserArgs(加 --remote-debugging-port)另建一份不發佈的
# 安裝檔,由宿主程式自己把參數交給 WebView2(runtime 唯一接受的方式),再讓 msedgedriver 以 debuggerAddress 附加。
if ($env:KEFU_E2E_BUILTIN_PORT) {
  $port = [int]$env:KEFU_E2E_BUILTIN_PORT
  Reset-AppData
  Note "模式 0:E2E 專用版(App 自開埠 $port),直接附加"
  $app = Start-Process -FilePath $env:KEFU_EXE -PassThru `
    -RedirectStandardOutput (Join-Path $out 'kefu-builtin.stdout.log') `
    -RedirectStandardError (Join-Path $out 'kefu-builtin.stderr.log')
  if (-not (Test-DevTools $port)) {
    Note "結果:模式 0 的 DevTools 埠 $port 沒有開(E2E 專用版的 additionalBrowserArgs 未生效)"
    Stop-Kefu
    exit 1
  }
  $ed = Start-EdgeDriver
  Start-Sleep -Seconds 3
  $env:DEBUGGER_ADDRESS = "127.0.0.1:$port"
  $rc = Run-Login 'attach' 'http://127.0.0.1:9515/'
  Note "結果:模式 0 exit=$rc"
  Stop-Process -Id $ed.Id -Force -ErrorAction SilentlyContinue
  Stop-Kefu
  exit $rc
}

# ---------- 1. tauri-driver ----------
Note "模式 1:tauri-driver"
$td = Start-Process -FilePath $tauriDriver -ArgumentList '--port', '4444', '--native-driver', $env:MSEDGEDRIVER -PassThru `
  -RedirectStandardOutput (Join-Path $out 'tauri-driver.stdout.log') `
  -RedirectStandardError (Join-Path $out 'tauri-driver.stderr.log')
Start-Sleep -Seconds 3
$rc = Run-Login 'tauri' 'http://127.0.0.1:4444/'
Stop-Process -Id $td.Id -Force -ErrorAction SilentlyContinue
Stop-Kefu
if ($rc -eq 0) { Note "結果:tauri-driver 模式成功"; exit 0 }
if (Test-Path (Join-Path $out '01-setup.png')) { Note "結果:tauri-driver 模式在流程中失敗(session 已建立)"; exit $rc }

# ---------- 2. 附加模式 ----------
$port = 9222
$regPath = 'HKCU:\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments'
$attached = $false
foreach ($how in 'env', 'registry') {
  Reset-AppData
  Note "模式 2:附加($how)"
  if ($how -like 'env*') {
    # --lang 作為對照:看環境變數的參數是否有出現在 WebView2 browser 行程的命令列
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port --lang=fr-FR"
  } else {
    Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
    New-Item -Path $regPath -Force | Out-Null
    New-ItemProperty -Path $regPath -Name 'kefu.exe' -Value "--remote-debugging-port=$port" -PropertyType String -Force | Out-Null
  }
  $app = Start-Process -FilePath $env:KEFU_EXE -PassThru `
    -RedirectStandardOutput (Join-Path $out "kefu-$how.stdout.log") `
    -RedirectStandardError (Join-Path $out "kefu-$how.stderr.log")
  if (Test-DevTools $port) { $attached = $true; break }
  Note "附加($how):DevTools 埠沒有開"
  Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'msedgewebview2' -and $_.CommandLine -notmatch '--type=' } |
    ForEach-Object { Note "browser 行程:$($_.CommandLine)" }
  Stop-Kefu
}
if (-not $attached) {
  Note "結果:環境變數與登錄覆寫都無法讓 kefu 的 WebView2 開 DevTools 埠"
  # 對照組:用官方 WebView2 SDK 自己開 WebView2,判斷是 runtime / runner 的問題還是 App 綁的 loader 的問題
  Remove-Item -Path $regPath -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
  & powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File (Join-Path $here 'webview2-probe.ps1') (Join-Path $out 'webview2-probe.log')
  Write-Output "::warning title=e2e-windows::WebView2 Runtime 不採用 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS / 登錄覆寫,WebDriver 無法連上 kefu.exe(見 e2e/README.md「Windows 已知限制」與 artifact 的 webview2-probe.log)"
  exit 1
}

$ed = Start-EdgeDriver
Start-Sleep -Seconds 3
$env:DEBUGGER_ADDRESS = "127.0.0.1:$port"
$rc = Run-Login 'attach' 'http://127.0.0.1:9515/'
Note "結果:附加模式 exit=$rc"
Stop-Process -Id $ed.Id -Force -ErrorAction SilentlyContinue
Remove-Item -Path $regPath -Recurse -Force -ErrorAction SilentlyContinue
exit $rc

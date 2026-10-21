# kefu 桌面版 Windows E2E 執行腳本(CI 的 e2e-windows job 呼叫;本機也可用)。
# 需要的環境變數:KEFU_EXE、MSEDGEDRIVER、E2E_EMAIL、E2E_PASSWORD(E2E_SERVER 選填)、E2E_OUT
# 選填:TAURI_DRIVER(tauri-driver.exe 路徑,預設 ~/.cargo/bin/tauri-driver.exe)
#
# 1. 先走標準路徑:tauri-driver → msedgedriver → 由 msedgedriver 啟動 kefu.exe。
# 2. 若連 session 都建不起來(WebView2 沒開 DevTools 埠,msedgedriver 回 "DevToolsActivePort file doesn't exist"),
#    改用附加模式:自己帶 --remote-debugging-port 啟動 kefu.exe(先試 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
#    環境變數,不行再試 WebView2 的登錄覆寫),再讓 msedgedriver 以 debuggerAddress 附加上去。
$ErrorActionPreference = 'Continue'
$out = $env:E2E_OUT
New-Item -ItemType Directory -Force $out | Out-Null
$testLog = Join-Path $out 'test.log'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$login = Join-Path $here 'login.mjs'
$tauriDriver = if ($env:TAURI_DRIVER) { $env:TAURI_DRIVER } else { Join-Path $env:USERPROFILE '.cargo\bin\tauri-driver.exe' }

function Note($msg) { "[$(Get-Date -Format o)] $msg" | Tee-Object -FilePath $testLog -Append }

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
  for ($i = 0; $i -lt 30; $i++) {
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
  if ($how -eq 'env') {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port"
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
if (-not $attached) { Note "結果:兩種方式都無法讓 WebView2 開 DevTools 埠"; exit 1 }

$ed = Start-Process -FilePath $env:MSEDGEDRIVER `
  -ArgumentList '--port=9515', '--verbose', "--log-path=$(Join-Path $out 'msedgedriver.log')" -PassThru
Start-Sleep -Seconds 3
$env:DEBUGGER_ADDRESS = "127.0.0.1:$port"
$rc = Run-Login 'attach' 'http://127.0.0.1:9515/'
Note "結果:附加模式 exit=$rc"
Stop-Process -Id $ed.Id -Force -ErrorAction SilentlyContinue
Remove-Item -Path $regPath -Recurse -Force -ErrorAction SilentlyContinue
exit $rc

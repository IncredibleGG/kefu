# Diagnostic (Windows PowerShell 5.1, STA). Kept ASCII-only on purpose: PS 5.1 reads BOM-less files as ANSI.
# Hosts a WebView2 with the official Microsoft.Web.WebView2 SDK and checks whether
# --remote-debugging-port from WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS takes effect on this runtime,
# both without and with AdditionalBrowserArguments in the environment options (wry/Tauri always sets them).
# Usage: powershell.exe -NoProfile -STA -File webview2-probe.ps1 <log file>
param([string]$LogFile = 'webview2-probe.log')
$ErrorActionPreference = 'Stop'
function Note($m) { "[$(Get-Date -Format o)] [probe] $m" | Tee-Object -FilePath $LogFile -Append }

$sdkVer = '1.0.3650.58'
$pkg = Join-Path $env:RUNNER_TEMP "wv2sdk-$sdkVer"
if (-not (Test-Path $pkg)) {
  $zip = "$pkg.zip"
  Invoke-WebRequest -Uri "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/$sdkVer" -OutFile $zip -UseBasicParsing
  Expand-Archive $zip -DestinationPath $pkg -Force
}
$env:PATH = (Join-Path $pkg 'runtimes\win-x64\native') + ';' + $env:PATH
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Path (Join-Path $pkg 'lib\net462\Microsoft.Web.WebView2.Core.dll')

function Wait-Task($t, $sec) {
  $deadline = (Get-Date).AddSeconds($sec)
  while (-not $t.IsCompleted -and (Get-Date) -lt $deadline) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 50 }
  if (-not $t.IsCompleted) { throw "timeout" }
  if ($t.IsFaulted) { throw $t.Exception }
  return $t.Result
}

$port = 9230
foreach ($case in 'no-options-args', 'with-options-args') {
  $port++
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port"
  $udf = Join-Path $env:RUNNER_TEMP "wv2probe-$case"
  try {
    $form = New-Object System.Windows.Forms.Form
    $form.Text = "probe $case"; $form.Width = 400; $form.Height = 300
    $form.Show()
    $opts = if ($case -eq 'with-options-args') {
      New-Object Microsoft.Web.WebView2.Core.CoreWebView2EnvironmentOptions('--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection')
    } else { $null }
    $wvEnv = Wait-Task ([Microsoft.Web.WebView2.Core.CoreWebView2Environment]::CreateAsync($null, $udf, $opts)) 60
    Note "${case}: runtime $($wvEnv.BrowserVersionString)"
    $ctl = Wait-Task ($wvEnv.CreateCoreWebView2ControllerAsync($form.Handle)) 60
    $ok = $false
    for ($i = 0; $i -lt 15; $i++) {
      [System.Windows.Forms.Application]::DoEvents()
      try { $v = Invoke-RestMethod "http://127.0.0.1:$port/json/version" -TimeoutSec 2; $ok = $true; break } catch { Start-Sleep -Seconds 1 }
    }
    Note "${case}: DevTools port $port open=$ok"
    Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -match [regex]::Escape($udf) -and $_.CommandLine -notmatch '--type=' } |
      ForEach-Object { Note "${case}: browser process: $($_.CommandLine)" }
    $ctl.Close(); $form.Close()
  } catch {
    Note "${case}: failed $($_.Exception.Message)"
  }
}

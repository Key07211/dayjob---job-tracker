# Starts every Windows file that gets released, so a release never ships a
# build that does not open: the unpacked app, the Setup installer (with
# -Install, installed silently for this user) and the portable app each run
# the desktop smoke test (which also fills in and submits a local job form in
# the Dayjob browser, and starts the JobSpy inside the app), and the Claude MCP
# bridge answers from inside the packaged app. The installed app also finds, downloads and verifies an update
# from a local copy of the files the release publishes for automatic updates.
#   npm run package:win
#   powershell -ExecutionPolicy Bypass -File scripts/verify-windows-build.ps1 -Version 0.1.0 [-Install]
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [switch]$Install
)
$ErrorActionPreference = 'Stop'
$release = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\release')).Path
$work = Join-Path ([IO.Path]::GetTempPath()) "dayjob-verify-$PID"
New-Item -ItemType Directory -Path $work -Force | Out-Null

function Invoke-Smoke([string]$Name, [string]$Exe) {
  if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) { throw "$Name not found: $Exe" }
  $dir = Join-Path $work $Name
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $result = Join-Path $dir 'result.json'
  $process = Start-Process -FilePath $Exe -ArgumentList @('--smoke-test', "`"$result`"") -PassThru
  if (-not $process.WaitForExit(180000)) { $process.Kill(); throw "$Name smoke test did not finish in 3 minutes" }
  # The portable launcher can return before the app inside it writes the report.
  $deadline = (Get-Date).AddSeconds(120)
  while (-not (Test-Path -LiteralPath $result) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }
  if (-not (Test-Path -LiteralPath $result)) { throw "$Name smoke test wrote no report (exit code $($process.ExitCode))" }
  # UTF-8 explicitly: Windows PowerShell 5.1 would read it in the system code page.
  $report = Get-Content -LiteralPath $result -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Output ("{0}: ok={1} rendererLoaded={2} startedIn={12} (system {13}, ok={14}) english={3} languageSaved={4} guide={11} browser={5} update={6} jobspy={7} closeKeepsRunning={8} version={9} executable={10}" -f
    $Name, $report.ok, $report.rendererLoaded, $report.english, $report.languageSaved, $report.browser.ok, $report.update.ok,
    $(if ($report.jobspy.builtIn -and $report.jobspy.available) { "built in $($report.jobspy.version)" } else { 'missing' }), $report.closeKeepsRunning, $report.version, $report.executable, $report.guide.ok,
    $report.languageAtStart.startedIn, $report.languageAtStart.system, $report.languageAtStart.ok)
  if ($report.timings) { Write-Output "${Name} timings (ms since the window loaded): $($report.timings | ConvertTo-Json -Compress)" }
  if ($report.error) { Write-Output "${Name} error: $($report.error)" }
  foreach ($line in @($report.log)) { if ($line) { Write-Output "${Name} renderer: $line" } }
  if (-not $report.ok -and $report.content) {
    $text = $report.content -replace '\s+', ' '
    Write-Output "${Name} window text: $($text.Substring(0, [Math]::Min(400, $text.Length)))"
  }
  if (-not $report.ok -and $report.guide) { Write-Output "${Name} guide steps: $($report.guide | ConvertTo-Json -Compress)" }
  if (-not $report.ok -and $report.browser) { Write-Output "${Name} browser steps: $($report.browser | ConvertTo-Json -Compress)" }
  if ($report.browser.error) { Write-Output "${Name} browser check: $($report.browser.error)" }
  if ($report.update.error) { Write-Output "${Name} update check: $($report.update.error)" }
  if ($env:DAYJOB_SMOKE_UPDATE_FEED -and $report.update.downloaded -ne $true) { throw "$Name did not download the test update" }
  if (-not $report.ok) { throw "$Name smoke test failed" }
  if ($report.version -cne $Version) { throw "$Name reports version $($report.version), expected $Version" }
  # Every released file carries a JobSpy that starts, so Glassdoor, ZipRecruiter and Google Jobs need no setup.
  if (-not ($report.jobspy.builtIn -and $report.jobspy.available)) { throw "${Name}: the JobSpy inside the app did not start ($($report.jobspy | ConvertTo-Json -Compress))" }
}

# The Python inside the app, started on its own: it is the JobSpy the build pinned, and it loads everything from
# its own folder, whatever Python this computer has.
function Test-Jobspy([string]$Exe) {
  $dir = Join-Path (Split-Path -Parent $Exe) 'resources\jobspy'
  $python = Join-Path $dir 'python.exe'
  if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw "The JobSpy inside the app is missing: $python" }
  $made = Get-Content -LiteralPath (Join-Path $dir 'runtime.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $env:PYTHONPATH = 'C:\dayjob-verify-must-be-ignored'
  try {
    $version = (& $python -X utf8 -m jobspy --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "python -m jobspy --version exited with $LASTEXITCODE" }
    if ($version -cne $made.jobspy) { throw "The JobSpy inside the app says it is '$version', not $($made.jobspy)" }
    $paths = (& $python -c "import sys, jobspy, pandas, numpy, curl_cffi, bs4, markdownify, pydantic, requests; print('|'.join(p for p in sys.path if p))" | Out-String).Trim().Split('|')
    if ($LASTEXITCODE -ne 0) { throw 'The JobSpy inside the app could not load its packages' }
    $outside = @($paths | Where-Object { -not ([IO.Path]::GetFullPath($_)).StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) })
    if ($outside.Count) { throw "The Python inside the app also looks outside its folder: $($outside -join ', ')" }
  } finally { Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue }
  $count = @(Get-ChildItem -LiteralPath $dir -Recurse -File).Count
  $megabytes = [Math]::Round((Get-ChildItem -LiteralPath $dir -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB)
  Write-Output "JobSpy inside the app: $version on Python $($made.python), $count files, $megabytes MB, loads only from its own folder"
}

# What Claude Code and Claude Desktop run after "Connect Claude": the app's own
# executable in Node mode with the bridge inside app.asar.
function Test-McpBridge([string]$Exe) {
  $bridge = Join-Path (Split-Path -Parent $Exe) 'resources\app.asar\integrations\mcp-server.mjs'
  $start = [Diagnostics.ProcessStartInfo]::new($Exe, "`"$bridge`"")
  $start.UseShellExecute = $false
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.Environment['ELECTRON_RUN_AS_NODE'] = '1'
  $start.Environment['DAYJOB_URL'] = 'http://127.0.0.1:4318'
  $process = [Diagnostics.Process]::Start($start)
  try {
    $read = {
      $line = $process.StandardOutput.ReadLineAsync()
      if (-not $line.Wait(30000)) { throw "MCP bridge did not answer: $($process.StandardError.ReadToEnd())" }
      $line.Result | ConvertFrom-Json
    }
    $process.StandardInput.WriteLine('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"dayjob-verify","version":"0"}}}')
    $hello = & $read
    if (-not $hello.result.serverInfo) { throw 'MCP bridge did not initialize' }
    $process.StandardInput.WriteLine('{"jsonrpc":"2.0","method":"notifications/initialized"}')
    $process.StandardInput.WriteLine('{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
    $tools = @((& $read).result.tools)
    Write-Output ("MCP bridge: {0} {1}, {2} tools" -f $hello.result.serverInfo.name, $hello.result.serverInfo.version, $tools.Count)
    if ($tools.Count -lt 1) { throw 'MCP bridge listed no tools' }
  } finally {
    if (-not $process.HasExited) { $process.Kill() }
  }
}

# What electron-updater reads: latest.yml next to the installer it names, and
# app-update.yml (the GitHub feed) inside the app.
function Test-UpdateFiles {
  $latest = Join-Path $release 'latest.yml'
  if (-not (Test-Path -LiteralPath $latest)) { throw 'latest.yml was not built' }
  $yaml = Get-Content -LiteralPath $latest -Raw -Encoding UTF8
  if ($yaml -notmatch "(?m)^version: $([regex]::Escape($Version))\s*$") { throw "latest.yml does not name version $Version" }
  if ($yaml -notmatch "(?m)^path: Dayjob-Setup-$([regex]::Escape($Version))\.exe\s*$") { throw "latest.yml does not point at Dayjob-Setup-$Version.exe" }
  if (-not (Test-Path -LiteralPath (Join-Path $release "Dayjob-Setup-$Version.exe.blockmap"))) { throw 'The installer blockmap was not built' }
  $feed = Get-Content -LiteralPath (Join-Path $release 'win-unpacked\resources\app-update.yml') -Raw -Encoding UTF8
  if ($feed -notmatch 'provider: github' -or $feed -notmatch 'repo: dayjob---job-tracker') { throw "app-update.yml does not point at the GitHub releases: $feed" }
  Write-Output 'update files: latest.yml, blockmap and app-update.yml are in place'
}

try {
  Test-UpdateFiles
  $unpacked = Join-Path $release 'win-unpacked\Dayjob.exe'
  Test-Jobspy $unpacked
  Invoke-Smoke 'unpacked' $unpacked
  Test-McpBridge $unpacked

  if ($Install) {
    $setup = Join-Path $release "Dayjob-Setup-$Version.exe"
    $installer = Start-Process -FilePath $setup -ArgumentList '/S' -Wait -PassThru
    if ($installer.ExitCode -ne 0) { throw "Setup exited with $($installer.ExitCode)" }
    $installed = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'Programs') -Filter 'Dayjob.exe' -Recurse -Depth 2 -File |
      Select-Object -First 1
    if (-not $installed) { throw 'Setup finished but Dayjob.exe is not under %LOCALAPPDATA%\Programs' }
    Write-Output "installed to $($installed.DirectoryName)"
    # The Start menu entry, which Windows needs to list Dayjob and show its notifications, and which an update puts
    # back when it went missing (by itself an update keeps the shortcuts as they are).
    $startLink = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Dayjob.lnk'
    if (-not (Test-Path -LiteralPath $startLink)) { throw "Setup did not create $startLink" }
    Remove-Item -LiteralPath $startLink -Force
    $update = Start-Process -FilePath $setup -ArgumentList @('/S', '--updated') -Wait -PassThru
    if ($update.ExitCode -ne 0) { throw "Setup run as an update exited with $($update.ExitCode)" }
    if (-not (Test-Path -LiteralPath $startLink)) { throw 'An update did not put the missing Start menu shortcut back' }
    Write-Output 'Start menu shortcut: created by Setup, and put back by an update'
    $env:DAYJOB_SMOKE_UPDATE_FEED = $release
    try { Invoke-Smoke 'installed' $installed.FullName } finally { Remove-Item Env:DAYJOB_SMOKE_UPDATE_FEED -ErrorAction SilentlyContinue }
  }

  Invoke-Smoke 'portable' (Join-Path $release "Dayjob-Portable-$Version.exe")
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

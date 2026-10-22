# Starts every Windows file that gets released, so a release never ships a
# build that does not open: the unpacked app, the Setup installer (with
# -Install, installed silently for this user) and the portable app each run
# the desktop smoke test, and the Claude MCP bridge answers from inside the
# packaged app.
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
  Write-Output ("{0}: ok={1} rendererLoaded={2} english={3} languageSaved={4} version={5} executable={6}" -f
    $Name, $report.ok, $report.rendererLoaded, $report.english, $report.languageSaved, $report.version, $report.executable)
  if (-not $report.ok) { throw "$Name smoke test failed" }
  if ($report.version -cne $Version) { throw "$Name reports version $($report.version), expected $Version" }
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

try {
  $unpacked = Join-Path $release 'win-unpacked\Dayjob.exe'
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
    Invoke-Smoke 'installed' $installed.FullName
  }

  Invoke-Smoke 'portable' (Join-Path $release "Dayjob-Portable-$Version.exe")
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

#Requires -Version 5.1
<#
.SYNOPSIS
  Daily-use launcher for Jarvis (built renderer, no Vite).

.PARAMETER Rebuild
  Force npm run build even when dist/index.html exists.
#>
param(
  [switch]$Rebuild
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir "..")).Path
Set-Location $RepoRoot

Write-Host "Starting Jarvis (built UI)…"

function Test-Command([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Test-OpenAiKey([string]$EnvPath) {
  if (-not (Test-Path $EnvPath)) { return $false }
  foreach ($line in Get-Content -Path $EnvPath -ErrorAction SilentlyContinue) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    if ($trimmed -match '^OPENAI_API_KEY\s*=\s*(.+)$') {
      $value = $Matches[1].Trim().Trim('"').Trim("'")
      if ($value.Length -gt 0) { return $true }
    }
  }
  return $false
}

function Test-JarvisAlreadyRunning([string]$Root) {
  $rootLeaf = Split-Path -Leaf $Root
  $markers = @(
    [regex]::Escape($Root),
    [regex]::Escape(($Root -replace '\\', '/')),
    'electron\\main\.cjs',
    'electron/main\.cjs'
  )
  $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -match '^(electron|Electron)(\.exe)?$' -and
      -not [string]::IsNullOrWhiteSpace($_.CommandLine)
    }
  foreach ($proc in $procs) {
    $cmd = [string]$proc.CommandLine
    foreach ($marker in $markers) {
      if ($cmd -match $marker) { return $true }
    }
    if ($cmd -match [regex]::Escape($rootLeaf) -and $cmd -match 'electron') {
      return $true
    }
  }
  return $false
}

function Stop-ProcessTree([int]$ProcessId) {
  if ($ProcessId -le 0) { return }
  try {
    & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null
  } catch {
    try { Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  }
}

if (-not (Test-Command "node")) {
  Write-Error "Node.js was not found. Install Node.js, then try again."
  exit 1
}
if (-not (Test-Command "npm")) {
  Write-Error "npm was not found."
  exit 1
}
if (-not (Test-Path (Join-Path $RepoRoot "package.json"))) {
  Write-Error "Launch script could not find the Jarvis project root."
  exit 1
}
if (-not (Test-Path (Join-Path $RepoRoot "node_modules\electron"))) {
  Write-Error "Dependencies missing. Run npm install in the Jarvis folder."
  exit 1
}

$EnvLocal = Join-Path $RepoRoot ".env.local"
if (-not (Test-Path $EnvLocal)) {
  Write-Error "Missing .env.local. Copy .env.example to .env.local and add OPENAI_API_KEY."
  exit 1
}
if (-not (Test-OpenAiKey $EnvLocal)) {
  Write-Error "OPENAI_API_KEY is missing in .env.local."
  exit 1
}

$DistHtml = Join-Path $RepoRoot "dist\index.html"
$NeedBuild = $Rebuild -or -not (Test-Path $DistHtml)
if ($NeedBuild) {
  Write-Host "Building Jarvis UI…"
  & npm run build
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Jarvis could not build. See messages above."
    exit 1
  }
  if (-not (Test-Path $DistHtml)) {
    Write-Error "Jarvis could not build. See messages above."
    exit 1
  }
}

# Ensure daily path never starts Vite.
Remove-Item Env:VITE_DEV_SERVER_URL -ErrorAction SilentlyContinue

$alreadyRunning = Test-JarvisAlreadyRunning $RepoRoot
if ($alreadyRunning) {
  Write-Host "Jarvis is already running"
}

# Prefer npm.cmd on Windows so Start-Process resolves reliably.
$npmPath = (Get-Command npm -ErrorAction Stop).Source
$proc = Start-Process -FilePath $npmPath -ArgumentList @("start") -WorkingDirectory $RepoRoot -NoNewWindow -PassThru
try {
  Wait-Process -Id $proc.Id
  $code = $proc.ExitCode
  if ($null -eq $code) { $code = 0 }
  if ($alreadyRunning -and $code -eq 0) {
    # Second launch focused the existing window; Electron printed/exited cleanly.
    exit 0
  }
  if ($code -ne 0) {
    Write-Error "Jarvis exited with an error (code $code)."
    exit $code
  }
} finally {
  if ($proc -and -not $proc.HasExited) {
    Stop-ProcessTree -ProcessId $proc.Id
  }
}

exit 0

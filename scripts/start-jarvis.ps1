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
$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $ScriptDir "..")).Path
Set-Location -LiteralPath $RepoRoot

Write-Host "Starting Jarvis (built UI)…"

function Test-Command([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Resolve-NpmStartExecutable {
  # Start-Process / CreateProcess cannot run npm.ps1. Prefer npm.cmd on Windows for builds.
  $npmCmd = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
  if ($npmCmd -and $npmCmd.Source -and (Test-Path -LiteralPath $npmCmd.Source)) {
    return $npmCmd.Source
  }

  $npm = Get-Command "npm" -ErrorAction SilentlyContinue
  if (-not $npm -or -not $npm.Source) {
    return $null
  }

  if ($npm.Source -match '\.ps1$') {
    $sibling = Join-Path (Split-Path -Parent $npm.Source) "npm.cmd"
    if (Test-Path -LiteralPath $sibling) {
      return $sibling
    }
    return $null
  }

  if (Test-Path -LiteralPath $npm.Source) {
    return $npm.Source
  }
  return $null
}

function Test-OpenAiKey([string]$EnvPath) {
  if (-not (Test-Path -LiteralPath $EnvPath)) { return $false }
  foreach ($line in Get-Content -LiteralPath $EnvPath -ErrorAction SilentlyContinue) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    if ($trimmed -match '^OPENAI_API_KEY\s*=\s*(.+)$') {
      $value = $Matches[1].Trim().Trim('"').Trim("'")
      if ($value.Length -gt 0) { return $true }
    }
  }
  return $false
}

function Normalize-PathCompare([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
  $trimmed = $Value.Trim().Trim('"').Trim("'")
  try {
    return [System.IO.Path]::GetFullPath($trimmed).TrimEnd('\', '/').ToLowerInvariant()
  } catch {
    return $trimmed.TrimEnd('\', '/').ToLowerInvariant()
  }
}

function Test-IsJarvisProcessCommandLine([string]$CommandLine, [string]$Root) {
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
  if ($CommandLine -match 'default_app\.asar') { return $false }

  $rootNorm = Normalize-PathCompare $Root
  if (-not $rootNorm) { return $false }
  $rootFwd = ($Root -replace '\\', '/')

  if ($CommandLine -match 'electron[/\\]main\.cjs') {
    $mainNeedle = ($rootNorm + '\electron\main.cjs')
    $mainNeedleFwd = ($rootFwd.ToLowerInvariant() + '/electron/main.cjs')
    if ($CommandLine.ToLowerInvariant().Contains($mainNeedle) -or $CommandLine.ToLowerInvariant().Contains($mainNeedleFwd)) {
      return $true
    }
  }

  if ($CommandLine -match '--app-path=(?:"([^"]+)"|''([^'']+)''|(\S+))') {
    $appPath = $Matches[1]; if (-not $appPath) { $appPath = $Matches[2] }; if (-not $appPath) { $appPath = $Matches[3] }
    if ($appPath -match 'default_app') { return $false }
    return (Normalize-PathCompare $appPath) -eq $rootNorm
  }

  if ($CommandLine -notmatch 'electron(\.exe)?') { return $false }

  # Require the absolute repository root as an application argument after electron.exe.
  # Do not treat the exe path under node_modules\electron\dist as the app path.
  if ($CommandLine -match 'electron\.exe["'']?\s+(.*)$') {
    $rest = $Matches[1].Trim()
    if (-not $rest -or $rest -match '^--type=') { return $false }
    if ($rest -match ('(?i)"' + [regex]::Escape($Root) + '"')) { return $true }
    if ($rest -match ("(?i)'" + [regex]::Escape($Root) + "'")) { return $true }
    if ($rest -match ('(?i)"' + [regex]::Escape($rootFwd) + '"')) { return $true }
    # Tokenize and compare (Start-Process passes spaced paths as one argv when unquoted in ArgumentList).
    $tokens = [regex]::Matches($rest, '"([^"]*)"|''([^'']*)''|(\S+)')
    foreach ($token in $tokens) {
      $arg = $token.Groups[1].Value
      if (-not $arg) { $arg = $token.Groups[2].Value }
      if (-not $arg) { $arg = $token.Groups[3].Value }
      if (-not $arg -or $arg.StartsWith('-')) { continue }
      if ((Normalize-PathCompare $arg) -eq $rootNorm) { return $true }
    }
  }

  return $false
}

function Test-JarvisAlreadyRunning([string]$Root) {
  $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -match '^(electron|Electron)(\.exe)?$' -and
      -not [string]::IsNullOrWhiteSpace($_.CommandLine)
    }
  foreach ($proc in $procs) {
    if (Test-IsJarvisProcessCommandLine -CommandLine ([string]$proc.CommandLine) -Root $Root) {
      return $true
    }
  }
  return $false
}

function Wait-JarvisProcessIdentity {
  param(
    [string]$Root,
    [int]$TimeoutSec = 45
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-JarvisAlreadyRunning $Root) {
      return $true
    }
    Start-Sleep -Milliseconds 250
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

$npmExe = Resolve-NpmStartExecutable
if (-not $npmExe) {
  Write-Error "npm was not found."
  exit 1
}

if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "package.json"))) {
  Write-Error "Launch script could not find the Jarvis project root."
  exit 1
}
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "node_modules\electron"))) {
  Write-Error "Dependencies missing. Run npm install in the Jarvis folder."
  exit 1
}

$ElectronExe = Join-Path $RepoRoot "node_modules\electron\dist\electron.exe"
if (-not (Test-Path -LiteralPath $ElectronExe)) {
  Write-Error "Electron executable was not found. Run npm install in the Jarvis folder."
  exit 1
}

$EnvLocal = Join-Path $RepoRoot ".env.local"
if (-not (Test-Path -LiteralPath $EnvLocal)) {
  Write-Error "Missing .env.local. Copy .env.example to .env.local and add OPENAI_API_KEY."
  exit 1
}
if (-not (Test-OpenAiKey $EnvLocal)) {
  Write-Error "OPENAI_API_KEY is missing in .env.local."
  exit 1
}

$DistHtml = Join-Path $RepoRoot "dist\index.html"
$NeedBuild = $Rebuild -or -not (Test-Path -LiteralPath $DistHtml)
if ($NeedBuild) {
  Write-Host "Building Jarvis UI…"
  & $npmExe run build
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Jarvis could not build. See messages above."
    exit 1
  }
  if (-not (Test-Path -LiteralPath $DistHtml)) {
    Write-Error "Jarvis could not build. See messages above."
    exit 1
  }
} elseif (-not $Rebuild) {
  # Stale-build warning only — never auto-rebuild here.
  try {
    $distTime = (Get-Item -LiteralPath $DistHtml).LastWriteTimeUtc
    $watch = @(
      (Join-Path $RepoRoot "src"),
      (Join-Path $RepoRoot "electron"),
      (Join-Path $RepoRoot "package.json"),
      (Join-Path $RepoRoot "vite.config.ts"),
      (Join-Path $RepoRoot "index.html")
    )
    $newest = $null
    foreach ($pathItem in $watch) {
      if (-not (Test-Path -LiteralPath $pathItem)) { continue }
      $item = Get-Item -LiteralPath $pathItem
      if ($item.PSIsContainer) {
        Get-ChildItem -LiteralPath $pathItem -Recurse -File -ErrorAction SilentlyContinue |
          Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\|\\.git\\' } |
          ForEach-Object {
            if ($null -eq $newest -or $_.LastWriteTimeUtc -gt $newest) { $newest = $_.LastWriteTimeUtc }
          }
      } else {
        if ($null -eq $newest -or $item.LastWriteTimeUtc -gt $newest) { $newest = $item.LastWriteTimeUtc }
      }
    }
    if ($null -ne $newest -and $newest -gt $distTime) {
      Write-Host "Built UI may be stale (source files newer than dist). Run: .\scripts\start-jarvis.ps1 -Rebuild"
    }
  } catch {
    # Non-fatal freshness check.
  }
}

# Ensure daily path never starts Vite.
Remove-Item Env:VITE_DEV_SERVER_URL -ErrorAction SilentlyContinue

$alreadyRunning = Test-JarvisAlreadyRunning $RepoRoot
if ($alreadyRunning) {
  Write-Host "Jarvis is already running"
}

# Explicit absolute app path — never bare electron.exe and never npm start → electron .
# Windows PowerShell Start-Process -ArgumentList @(unquotedPath) splits on spaces
# (C:\Users\Sarah …). Use ProcessStartInfo.Arguments with one quoted token instead.
function Start-JarvisElectronProcess {
  param(
    [Parameter(Mandatory = $true)][string]$ElectronExe,
    [Parameter(Mandatory = $true)][string]$RepoRoot
  )
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $ElectronExe
  $psi.WorkingDirectory = $RepoRoot
  $psi.UseShellExecute = $false
  # Exactly one CreateProcess argument: quoted absolute repository root.
  $psi.Arguments = '"' + ($RepoRoot -replace '"', '\"') + '"'
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  $started = $process.Start()
  if (-not $started) {
    return $null
  }
  return $process
}

$proc = Start-JarvisElectronProcess -ElectronExe $ElectronExe -RepoRoot $RepoRoot
if (-not $proc) {
  Write-Error "Jarvis could not start."
  exit 1
}

$identityConfirmed = $false
try {
  if ($alreadyRunning) {
    # Second launch: Electron single-instance lock focuses the existing Jarvis window.
    Wait-Process -Id $proc.Id
    $code = $proc.ExitCode
    if ($null -eq $code) { $code = 0 }
    if ($code -ne 0) {
      Write-Error "Jarvis exited with an error (code $code)."
      exit $code
    }
    exit 0
  }

  $identityConfirmed = Wait-JarvisProcessIdentity -Root $RepoRoot -TimeoutSec 45
  if (-not $identityConfirmed) {
    Stop-ProcessTree -ProcessId $proc.Id
    Write-Error "Jarvis did not start as the expected application (Electron default app is not Jarvis)."
    exit 1
  }

  # Withhold success until process identity confirms this repo app path.
  # main.cjs prints [jarvis-launch] ready only after app.getAppPath() matches the repository.
  Write-Host "[jarvis-launch] process identity confirmed"

  # Long-running Electron stays alive until the user quits; Wait-Process is success, not failure.
  Wait-Process -Id $proc.Id
  $code = $proc.ExitCode
  if ($null -eq $code) { $code = 0 }
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

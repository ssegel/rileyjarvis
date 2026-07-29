#Requires -Version 5.1
<#
.SYNOPSIS
  Create or update a Desktop shortcut to Jarvis daily launch.

.PARAMETER Replace
  Overwrite an existing Jarvis.lnk that targets something else.

.PARAMETER ShortcutName
  Desktop shortcut filename. Default: Jarvis.lnk
#>
param(
  [switch]$Replace,
  [string]$ShortcutName = "Jarvis.lnk"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $ScriptDir "..")).Path
$TargetBat = Join-Path $RepoRoot "scripts\start-jarvis.bat"

if (-not (Test-Path -LiteralPath $TargetBat)) {
  Write-Error "Could not find scripts\start-jarvis.bat under $RepoRoot"
  exit 1
}

$Desktop = [Environment]::GetFolderPath("Desktop")
if (-not $Desktop -or -not (Test-Path -LiteralPath $Desktop)) {
  Write-Error "Desktop folder is unavailable."
  exit 1
}

$ShortcutPath = Join-Path $Desktop $ShortcutName
$TargetBatFull = (Resolve-Path -LiteralPath $TargetBat).Path

function Get-ShortcutTarget([string]$Path) {
  try {
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($Path)
    return [string]$lnk.TargetPath
  } catch {
    return $null
  }
}

function Normalize-PathCompare([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
  try {
    return ([IO.Path]::GetFullPath($Value.Trim().Trim('"'))).TrimEnd('\').ToLowerInvariant()
  } catch {
    return $Value.Trim().Trim('"').TrimEnd('\').ToLowerInvariant()
  }
}

if (Test-Path -LiteralPath $ShortcutPath) {
  $existingTarget = Get-ShortcutTarget $ShortcutPath
  $existingNorm = Normalize-PathCompare $existingTarget
  $desiredNorm = Normalize-PathCompare $TargetBatFull
  if ($existingNorm -and $existingNorm -ne $desiredNorm) {
    if (-not $Replace) {
      Write-Error ("Desktop shortcut already exists and targets something else:`n  {0}`n  Existing target: {1}`nRe-run with -Replace to overwrite." -f $ShortcutPath, $existingTarget)
      exit 2
    }
    Write-Host ("Replacing unrelated shortcut that targeted: {0}" -f $existingTarget)
  } else {
    Write-Host "Updating existing Jarvis shortcut in place…"
  }
}

try {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  $shortcut.TargetPath = $TargetBatFull
  $shortcut.WorkingDirectory = $RepoRoot
  $shortcut.WindowStyle = 1
  $shortcut.Description = "Start Jarvis (built UI)"
  $shortcut.Save()
} catch {
  Write-Error ("Could not create desktop shortcut: {0}" -f $_.Exception.Message)
  exit 1
}

Write-Host ("Desktop shortcut ready: {0}" -f $ShortcutPath)
Write-Host ("Target: {0}" -f $TargetBatFull)
exit 0

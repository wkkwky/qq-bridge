# Sync config.json dsh.baseUrl to the port DSH Desktop is currently listening on.
# DSH Desktop (Electron) picks a random free port on every launch, so run this after starting DSH,
# then restart qq-bridge. See issue #56.
# Usage: powershell -ExecutionPolicy Bypass -File D:\qq-bridge\sync-dsh-port.ps1
# start.bat calls this with -NoPause: an unattended launch must never block on Read-Host.

param([switch]$NoPause)

function Wait-Exit { if (-not $NoPause) { Read-Host 'Press Enter to exit' } }

$ErrorActionPreference = 'Stop'
$cfgPath = Join-Path $PSScriptRoot 'config.json'

if (-not (Test-Path $cfgPath)) {
  Write-Host "config.json not found: $cfgPath"
  Wait-Exit
  exit 1
}

$ports = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
  $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -match 'deepseek|harness|dsh') { $_.LocalPort }
} | Sort-Object -Unique)

if ($ports.Count -eq 0) {
  Write-Host 'DSH Desktop is not running. Start it first, then run this script again.'
  Wait-Exit
  exit 1
}
if ($ports.Count -gt 1) {
  Write-Host ('Multiple candidate ports found: ' + ($ports -join ', ') + ' - using the first one.')
  Write-Host 'If the bridge connects to the wrong instance, edit config.json manually.'
}
$port = $ports[0]

# Read as UTF-8 explicitly: PowerShell 5.1's Get-Content -Raw assumes ANSI for BOM-less files,
# which turns Chinese text into mojibake before it ever gets written back.
$raw = [System.IO.File]::ReadAllText($cfgPath, [System.Text.Encoding]::UTF8)
$m = [regex]::Match($raw, '"baseUrl"\s*:\s*"([^"]*)"')
if (-not $m.Success) {
  Write-Host 'No "baseUrl" field found in config.json.'
  Wait-Exit
  exit 1
}

$old = $m.Groups[1].Value
$new = "http://127.0.0.1:$port"
$raw = [regex]::Replace($raw, '("baseUrl"\s*:\s*")[^"]*(")', ('${1}' + $new + '${2}'))

try {
  $null = $raw | ConvertFrom-Json
} catch {
  Write-Host "Refusing to write: the result is not valid JSON, config.json left untouched. ($($_.Exception.Message))"
  Wait-Exit
  exit 1
}
Copy-Item $cfgPath "$cfgPath.bak" -Force

# Write back as UTF-8 without BOM: Node's JSON.parse chokes on a BOM.
[System.IO.File]::WriteAllText($cfgPath, $raw, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "dsh.baseUrl: $old  ->  $new"
Write-Host 'Done. Restart qq-bridge; wait for "DSH ready" in its log.'
Wait-Exit

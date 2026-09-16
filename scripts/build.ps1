# SessionHarbor 一键构建（Windows PowerShell）
# 用法: .\scripts\build.ps1 [-SkipDesktop]
param([switch]$SkipDesktop, [switch]$SkipInstall)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$node = if ($env:MIMO_NODE) { $env:MIMO_NODE } else { "node" }
$tscJs = Get-ChildItem -Path "node_modules\.pnpm" -Recurse -Filter "tsc.js" -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match "typescript@" } |
  Select-Object -First 1 -ExpandProperty FullName
if (-not $tscJs) {
  Write-Host "未找到 typescript，请先 pnpm install"
  exit 1
}
Write-Host "tsc: $tscJs"

$pkgs = @(
  "packages\core",
  "packages\adapters\alink",
  "packages\adapters\claude-code",
  "packages\adapters\workbuddy",
  "packages\adapters\codex",
  "packages\adapters\mimo",
  "packages\adapters\deepseek-harness",
  "packages\adapters\devin",
  "packages\adapters\trae-solo",
  "packages\adapters\chatgpt-export",
  "packages\adapters\cursor",
  "packages\adapters\vscode",
  "packages\adapters\openclaw",
  "packages\cloud-server",
  "packages\cli"
)
if (-not $SkipDesktop) { $pkgs += "apps\desktop" }

foreach ($p in $pkgs) {
  if (-not (Test-Path "$p\tsconfig.json")) { Write-Host "skip $p"; continue }
  Write-Host "build $p"
  & $node $tscJs -p "$p\tsconfig.json"
  if ($LASTEXITCODE -ne 0) {
    Write-Host "FAILED $p" -ForegroundColor Red
    exit 1
  }
}

# preload
if (-not $SkipDesktop) {
  Copy-Item "apps\desktop\src\preload.cjs" "apps\desktop\dist\preload.cjs" -Force
}

Write-Host "`n构建完成" -ForegroundColor Green
Write-Host "  CLI:   node packages\cli\dist\bin.js info"
Write-Host "  云:    node packages\cloud-server\dist\server.js"
Write-Host "  GUI:   cd apps\desktop; npx electron ."
Write-Host "  或:    .\SessionHarbor.exe（便携版）"

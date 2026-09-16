# SessionHarbor Cloud 备份
# 用法: .\scripts\cloud-backup.ps1 [-DataDir D:\harbor-cloud\data] [-OutDir D:\backups\harbor-cloud]
param(
  [string]$DataDir = $(if ($env:HARBOR_CLOUD_DATA) { $env:HARBOR_CLOUD_DATA } else { "D:\SessionHarbor\cloud-data" }),
  [string]$OutDir = "D:\SessionHarbor\backups\harbor-cloud"
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path $DataDir)) { Write-Host "数据目录不存在: $DataDir"; exit 1 }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$ts = Get-Date -Format "yyyyMMdd-HHmmss"
$dest = Join-Path $OutDir "harbor-cloud-$ts"
New-Item -ItemType Directory -Force -Path $dest | Out-Null

# 1) SQLite 在线备份（避免直接拷 wal 半截）
$db = Join-Path $DataDir "cloud.db"
if (Test-Path $db) {
  $py = $env:MIMO_PYTHON
  if (-not $py) { $py = "python" }
  & $py -c "import sqlite3; src=sqlite3.connect(r'$db'); dst=sqlite3.connect(r'$dest\cloud.db'); src.backup(dst); src.close(); dst.close(); print('db ok')"
}

# 2) 用户密文目录
$users = Join-Path $DataDir "users"
if (Test-Path $users) {
  Copy-Item $users -Destination (Join-Path $dest "users") -Recurse -Force
}
$zip = "$dest.zip"
Compress-Archive -Path "$dest\*" -DestinationPath $zip -Force
Write-Host "备份完成: $zip"

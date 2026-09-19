# 一键写入 Supabase 云配置（公司/个人电脑各跑一次）
# 用法: .\scripts\setup-supabase.ps1
param(
  [string]$DatabaseUrl = "postgresql://postgres.hnrvuzgljxwixspbwgaw:ggxqq2607101627@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres",
  [string]$Workdir = "D:\SessionHarbor",
  [string]$AdminToken = "admin-delight-0628",
  [string]$Email = "",
  [string]$Password = ""
)
$ErrorActionPreference = "Stop"
$dir = Join-Path $Workdir ".sessionharbor"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$envFile = Join-Path $dir "cloud.env"
@"
DATABASE_URL=$DatabaseUrl
HARBOR_CLOUD_PG_SSL_INSECURE=1
HARBOR_CLOUD_ADMIN_TOKEN=$AdminToken
HARBOR_CLOUD_MAIL=console
HARBOR_CLOUD_PORT=8787
"@ | Set-Content $envFile -Encoding UTF8

# 合并进 sync config.json
$sync = Join-Path $dir "sync\config.json"
New-Item -ItemType Directory -Force -Path (Split-Path $sync) | Out-Null
$cfg = @{}
if (Test-Path $sync) {
  try { $cfg = Get-Content $sync -Raw | ConvertFrom-Json -AsHashtable } catch { $cfg = @{} }
}
if (-not $cfg.passphrase) {
  $cfg.passphrase = -join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
}
$cfg.targetKind = "hosted"
$cfg.hostedEndpoint = "http://127.0.0.1:8787"
$cfg.databaseUrl = $DatabaseUrl
$cfg | ConvertTo-Json -Depth 6 | Set-Content $sync -Encoding UTF8
Write-Host "已写入: $envFile"
Write-Host "已写入: $sync"
Write-Host "passphrase: $($cfg.passphrase)"
Write-Host "请重启 SessionHarbor.exe（将自动拉起内嵌云服务）"

if ($Email -and $Password) {
  $harbor = Join-Path $Workdir "packages\cli\dist\bin.js"
  $node = if ($env:MIMO_NODE) { $env:MIMO_NODE } else { "node" }
  Write-Host "注册/登录 $Email ..."
  & $node $harbor register --email $Email --password $Password --endpoint http://127.0.0.1:8787 --workdir $Workdir
  if ($LASTEXITCODE -ne 0) {
    & $node $harbor login --email $Email --password $Password --endpoint http://127.0.0.1:8787 --workdir $Workdir
  }
  Write-Host "可执行: harbor sync push client --client alink --endpoint http://127.0.0.1:8787"
}

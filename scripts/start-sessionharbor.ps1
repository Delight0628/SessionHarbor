# 一键启动 SessionHarbor + 内嵌 Supabase 云
# 用法: .\scripts\start-sessionharbor.ps1
$ErrorActionPreference = "Stop"
$root = "D:\SessionHarbor"
Set-Location $root
$env:HARBOR_WORKDIR = $root
$envFile = Join-Path $root ".sessionharbor\cloud.env"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$') {
      Set-Item -Path "env:$($Matches[1])" -Value ($Matches[2] -replace '^["'']|["'']$', '')
    }
  }
}
Write-Host "DATABASE_URL 已加载: $([bool]$env:DATABASE_URL)"
$el = "D:\SessionHarbor\node_modules\.pnpm\electron@37.10.3\node_modules\electron\dist\electron.exe"
if (-not (Test-Path $el)) { $el = (Get-Command electron -ErrorAction SilentlyContinue).Source }
if (-not $el) { Write-Host "未找到 electron"; exit 1 }
# 确保 cloud-server dist 存在
if (-not (Test-Path "$root\packages\cloud-server\dist\server.js")) {
  Write-Host "请先构建: .\scripts\build.ps1"; exit 1
}
Start-Process -FilePath $el -ArgumentList "$root\apps\desktop" -WorkingDirectory "$root\apps\desktop"
Write-Host "已启动 SessionHarbor（内嵌云服务随应用拉起）"
Write-Host "GUI 顶栏 →「云账号」登录后即可推送/拉取"

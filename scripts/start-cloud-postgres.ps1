$ErrorActionPreference = "Stop"
Set-Location "D:\SessionHarbor"
Get-NetTCPConnection -LocalPort 8787 -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

Get-Content "D:\SessionHarbor\.sessionharbor\cloud.env" | ForEach-Object {
  if ($_ -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$') {
    Set-Item -Path ("env:" + $Matches[1]) -Value ($Matches[2] -replace '^["'']|["'']$', '')
  }
}
$env:HARBOR_WORKDIR = "D:\SessionHarbor"
$env:PORT = "8787"
$env:HARBOR_CLOUD_PORT = "8787"
Write-Host "DATABASE_URL loaded: $([bool]$env:DATABASE_URL)"
Write-Host "SSL_INSECURE: $($env:HARBOR_CLOUD_PG_SSL_INSECURE)"

$p = Start-Process -FilePath "D:\nodejs\node.exe" `
  -ArgumentList "packages\cloud-server\dist\server.js" `
  -WorkingDirectory "D:\SessionHarbor" `
  -RedirectStandardOutput "D:\SessionHarbor\cloud-server.log" `
  -RedirectStandardError "D:\SessionHarbor\cloud-server.err.log" `
  -WindowStyle Hidden -PassThru
Write-Host "PID=$($p.Id)"
Start-Sleep -Seconds 6
try {
  $r = Invoke-RestMethod "http://127.0.0.1:8787/healthz" -TimeoutSec 8
  Write-Host "HEALTH: $($r | ConvertTo-Json -Compress)"
} catch {
  Write-Host "HEALTH_ERR: $($_.Exception.Message)"
}
Write-Host "---stdout---"
Get-Content "D:\SessionHarbor\cloud-server.log" -ErrorAction SilentlyContinue
Write-Host "---stderr---"
Get-Content "D:\SessionHarbor\cloud-server.err.log" -ErrorAction SilentlyContinue | Select-Object -Last 40

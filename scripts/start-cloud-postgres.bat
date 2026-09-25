@echo off
setlocal
cd /d D:\SessionHarbor
for /f "usebackq tokens=1,* delims==" %%A in (".sessionharbor\cloud.env") do (
  if not "%%A"=="" set "%%A=%%B"
)
set HARBOR_WORKDIR=D:\SessionHarbor
set PORT=8787
set HARBOR_CLOUD_PORT=8787
start "SessionHarborCloud" /b "D:\nodejs\node.exe" packages\cloud-server\dist\server.js > cloud-server.log 2> cloud-server.err.log
timeout /t 4 >nul
curl -s http://127.0.0.1:8787/healthz
echo.
echo DONE

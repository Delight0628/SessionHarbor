@echo off
setlocal
set ROOT=%~dp0..
if not exist "%ROOT%\packages\cloud-server\dist\server.js" (
  echo [错误] 未找到 cloud-server 构建产物，请先构建
  exit /b 1
)
node "%ROOT%\packages\cloud-server\dist\server.js"

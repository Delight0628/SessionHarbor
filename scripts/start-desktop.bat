@echo off
setlocal
set ROOT=%~dp0..
set ELECTRON=%ROOT%\node_modules\.pnpm\electron@37.10.3\node_modules\electron\dist\electron.exe
if not exist "%ELECTRON%" (
  echo [错误] 未找到 Electron: %ELECTRON%
  exit /b 1
)
pushd "%ROOT%\apps\desktop"
"%ELECTRON%" .
set ERR=%ERRORLEVEL%
popd
exit /b %ERR%

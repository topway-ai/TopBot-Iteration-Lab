@echo off
setlocal
set "TOOL_NODE=%LOCALAPPDATA%\Programs\CodeGraph\1.6.3\codegraph-win32-x64\node.exe"
if not exist "%TOOL_NODE%" set "TOOL_NODE=node.exe"
"%TOOL_NODE%" --max-old-space-size=384 "%~dp0topbot-development.mjs" %*
exit /b %ERRORLEVEL%

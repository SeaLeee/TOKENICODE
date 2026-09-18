@echo off
REM One-click launcher for the Godot-MCP local service (streamableHttp on :8080).
REM
REM   gamedev-mcp-server (com.IvanMurzak.GameDev.MCP.Server) exposes the MCP
REM   endpoint at http://localhost:8080/mcp — no OAuth / no token in local mode.
REM
REM Steps performed:
REM   1. Ensure the .NET SDK (`dotnet`) is on PATH.
REM   2. Install the GameDev.MCP.Server global tool if it is missing.
REM   3. Prepend %USERPROFILE%\.dotnet\tools so the tool's shim is found.
REM   4. Run the server, streaming logs to the console.

setlocal
set "TOOL_PACKAGE=com.IvanMurzak.GameDev.MCP.Server"
set "TOOL_COMMAND=gamedev-mcp-server"
set "PORT=8080"

rem --- 1. dotnet must be available -------------------------------------------
where dotnet >nul 2>nul
if errorlevel 1 (
  echo [ERROR] dotnet was not found on PATH.
  echo         Install the .NET 8+ SDK from https://dotnet.microsoft.com/download
  pause
  exit /b 1
)

rem --- 2. Install the global tool if missing ---------------------------------
set "DOTNET_TOOLS=%USERPROFILE%\.dotnet\tools"
if not exist "%DOTNET_TOOLS%\%TOOL_COMMAND%.exe" (
  echo [INFO] %TOOL_COMMAND% not found — installing %TOOL_PACKAGE% ...
  dotnet tool install --global %TOOL_PACKAGE%
  if errorlevel 1 (
    echo [ERROR] Failed to install %TOOL_PACKAGE%.
    pause
    exit /b 1
  )
)

rem --- 3. Put the tool shim on PATH ------------------------------------------
set "PATH=%DOTNET_TOOLS%;%PATH%"

rem --- 4. Launch the server ---------------------------------------------------
echo [INFO] Starting %TOOL_COMMAND% on http://localhost:%PORT%/mcp
echo [INFO] Configure the MCP server URL as: http://localhost:%PORT%/mcp
echo [INFO] Press Ctrl+C to stop.
"%DOTNET_TOOLS%\%TOOL_COMMAND%.exe" --client-transport streamableHttp --port %PORT%

endlocal

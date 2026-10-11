@echo off
REM Quick launch for TOKENICODE (Tauri 2 dev build)
REM
REM - Prepends %USERPROFILE%\.cargo\bin to PATH so `cargo` is found (the
REM   shell PATH may be stale after a Rust install).
REM - Limits parallel Rust jobs to avoid Windows "os error 1450" on
REM   low-RAM machines.
REM - Runs from the script's own directory so it works from any cwd.
REM - Frees port 1420 first: a previous run can leave its Vite behind (killing
REM   the app does not kill its beforeDevCommand), and the next start would then
REM   die with "Port 1420 is already in use".
REM - Switches the console to UTF-8: under the default code page Vite's
REM   box-drawing characters render as mojibake.

setlocal
chcp 65001 >nul
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
set "CARGO_BUILD_JOBS=4"
cd /d "%~dp0"

for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":1420" ^| findstr LISTENING') do (
  echo [start.bat] freeing port 1420 (pid %%p)
  taskkill /F /PID %%p >nul 2>&1
)

call pnpm tauri dev

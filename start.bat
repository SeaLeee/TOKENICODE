@echo off
REM Quick launch for TOKENICODE (Tauri 2 dev build)
REM
REM - Prepends %USERPROFILE%\.cargo\bin to PATH so `cargo` is found (the
REM   shell PATH may be stale after a Rust install).
REM - Limits parallel Rust jobs to avoid Windows "os error 1450" on
REM   low-RAM machines.
REM - Runs from the script's own directory so it works from any cwd.

setlocal
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
set "CARGO_BUILD_JOBS=4"
cd /d "%~dp0"

call pnpm tauri dev

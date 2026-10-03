@echo off
chcp 65001 >nul 2>&1
rem === doyu admin launcher (Windows) =========================================
rem  KEEP THIS FILE ASCII-ONLY. cmd.exe parses a .bat line by line using the
rem  console codepage (932 here), so Japanese text in the file -- even in a
rem  rem comment -- is read as garbage and executed as commands. "chcp 65001"
rem  at the top does NOT fix that; it only makes node's UTF-8 output readable.
rem
rem  Double click        -> dump the database in readable form (admin recent)
rem  doyu.bat show <url>
rem  doyu.bat remove <url> <tag> --clause 1 --reason "..."
rem  doyu.bat deny tag "..." --reason "..."   /   doyu.bat undeny tag "..."
rem  doyu.bat deny-list
rem
rem  What it does: fix the codepage -> export AWS credentials into the
rem  environment (the SDK cannot refresh an "aws login" session by itself)
rem  -> run scripts\admin.mjs.
rem ==========================================================================

cd /d "%~dp0"

rem Before launch the live service is dev (docs/09, decision 14).
if "%STAGE%"=="" set "STAGE=dev"

aws sts get-caller-identity >nul 2>&1
if errorlevel 1 (
  echo.
  echo   AWS session expired. Run this first, then try again:
  echo.
  echo       aws login
  echo.
  pause
  exit /b 1
)

for /f "usebackq tokens=1,* delims==" %%a in (`aws configure export-credentials --format env-no-export`) do set "%%a=%%b"

if "%~1"=="" (
  node scripts\admin.mjs recent
  echo.
  pause
) else (
  node scripts\admin.mjs %*
)

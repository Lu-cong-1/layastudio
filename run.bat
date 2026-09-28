@echo off
REM LayaStudio launcher (uses project-local .venv)
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo [setup] creating venv...
  python -m venv .venv
  .venv\Scripts\python.exe -m pip install -r requirements.txt
)
.venv\Scripts\python.exe -m layastudio %*

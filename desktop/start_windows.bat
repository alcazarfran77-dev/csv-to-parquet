@echo off
setlocal
cd /d "%~dp0"
title CSV to Parquet

rem ---- Find Python (the "py" launcher first, then "python") ----
set "PY="
py -3 -c "import sys, tkinter; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>nul && set "PY=py -3"
if not defined PY (
  python -c "import sys, tkinter; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo.
  echo  Python 3.9 or later with Tkinter was not found.
  echo  Install it from https://www.python.org/downloads/
  echo  ^(tick "Add python.exe to PATH" in the installer^) and open this file again.
  echo.
  pause
  exit /b 1
)

rem ---- First run: create a private environment and install the dependencies ----
if not exist ".venv\ready.txt" (
  echo.
  echo  Setting up the app for the first time. This takes 1-2 minutes...
  echo.
  if exist ".venv" rmdir /s /q ".venv"
  %PY% -m venv .venv || goto :failed
  ".venv\Scripts\python.exe" -m pip install --upgrade pip --disable-pip-version-check -q
  ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q "pyarrow>=14" || goto :failed
  ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q tkinterdnd2 || echo  ^(Drag and drop not available; the app works anyway.^)
  echo ok> ".venv\ready.txt"
)

rem ---- Open the app without a console window ----
start "" ".venv\Scripts\pythonw.exe" "%~dp0csv_to_parquet.py" %*
exit /b 0

:failed
echo.
echo  The requirements could not be installed. Check the internet connection
echo  or the company proxy ^(see README.md, "Troubleshooting"^).
echo.
pause
exit /b 1

@echo off
setlocal
cd /d "%~dp0"
title Build the CSV to Parquet executable

rem Creates a folder with "CSV to Parquet.exe" that runs on other Windows
rem computers WITHOUT installing Python. It uses the environment prepared by
rem start_windows.bat (if it does not exist, run that file once first).

if not exist ".venv\ready.txt" (
  echo.
  echo  First open the app once with start_windows.bat
  echo  ^(that prepares the environment^) and then run this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo  Installing PyInstaller...
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q pyinstaller || goto :failed

echo  Building the executable ^(a few minutes^)...
".venv\Scripts\python.exe" -m PyInstaller --noconfirm --clean --windowed ^
  --name "CSV to Parquet" --icon icon.ico ^
  --add-data "..\locales;locales" ^
  --collect-all tkinterdnd2 --collect-data tzdata ^
  --exclude-module pyarrow.tests --exclude-module pandas --exclude-module numpy.tests ^
  csv_to_parquet.py || goto :failed

echo.
echo  Done. The program is in:
echo     %~dp0dist\CSV to Parquet\CSV to Parquet.exe
echo  To share it, zip and send the whole "dist\CSV to Parquet" folder.
echo.
explorer "dist\CSV to Parquet"
pause
exit /b 0

:failed
echo.
echo  The executable could not be built. Check the messages above.
pause
exit /b 1

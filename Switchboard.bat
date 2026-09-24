@echo off
rem Starts Switchboard. Safe to run twice - a second launch just brings the
rem existing window forward.
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."

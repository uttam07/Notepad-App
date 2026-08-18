@echo off
rem ============================================
rem  Steno - one-click launcher
rem  Opens Steno in a chromeless app window
rem  (Chrome or Edge, whichever is installed).
rem  Tip: right-click this file -> Pin to Start
rem  or send a shortcut to your desktop.
rem ============================================
setlocal
set "URL=file:///%~dp0index.html"
set "URL=%URL:\=/%"

for %%P in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
) do (
  if exist %%P (
    start "" %%P "--app=%URL%"
    exit /b 0
  )
)

rem Fallback: default browser, normal tab
start "" "%URL%"

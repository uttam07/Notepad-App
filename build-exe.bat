@echo off
rem ============================================
rem  Rebuilds dist\Steno.exe (lightweight, ~1 MB)
rem  Uses the C# compiler built into Windows and
rem  the WebView2 SDK assemblies in build\.
rem ============================================
setlocal
cd /d "%~dp0"
set "CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist dist mkdir dist

"%CSC%" /nologo /target:winexe /platform:x64 /out:dist\Steno.exe build\Steno.cs ^
  /reference:build\Microsoft.Web.WebView2.Core.dll ^
  /reference:build\Microsoft.Web.WebView2.WinForms.dll ^
  /resource:build\Microsoft.Web.WebView2.Core.dll,Microsoft.Web.WebView2.Core.dll ^
  /resource:build\Microsoft.Web.WebView2.WinForms.dll,Microsoft.Web.WebView2.WinForms.dll ^
  /resource:build\WebView2Loader.dll,WebView2Loader.dll ^
  /resource:index.html,app/index.html ^
  /resource:css\style.css,app/css/style.css ^
  /resource:js\app.js,app/js/app.js ^
  /resource:js\highlighter.js,app/js/highlighter.js ^
  /resource:icons\icon.ico,app.ico ^
  /win32icon:icons\icon.ico

if errorlevel 1 ( echo BUILD FAILED & pause & exit /b 1 )
echo.
echo Built dist\Steno.exe
pause

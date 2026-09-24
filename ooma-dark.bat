@echo off
rem Launches Ooma Enterprise with Chromium's built-in dark rendering.
rem
rem --force-dark-mode                     reports "dark" to the app (prefers-color-scheme)
rem --enable-features=WebContentsForceDark  algorithmically darkens pages that have no dark theme
rem
rem Quit the app FULLY first, including the tray icon. A running instance
rem swallows the launch and these flags are silently ignored.

start "" "%LOCALAPPDATA%\Programs\office-desktop-oe\Ooma Enterprise.exe" --force-dark-mode --enable-features=WebContentsForceDark

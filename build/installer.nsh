; electron-builder's installer keeps a copy of itself in %LOCALAPPDATA%\audit-tool-updater for its auto-updater, and
; its uninstaller leaves it there. This program has no auto-updater, so the copy is removed right after installing.
!macro customInstall
  Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
  RMDir "$LOCALAPPDATA\audit-tool-updater"
!macroend

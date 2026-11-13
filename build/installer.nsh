; Hooks into electron-builder's NSIS installer (assisted, per user).

; Only for the current user: no admin rights, so the "for all users" page is skipped.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; The person picks the folder, and the uninstaller deletes that folder with everything in it. So it is always a folder
; of its own: when its last part is not "Audit Tool", that is added (D:\Tools becomes D:\Tools\Audit Tool). Run after
; the folder page, and in .onInit for a silent install with /D, which shows no pages.
!macro ownFolder
  StrCpy $R9 $INSTDIR 1 -1
  ${If} $R9 == "\"
    StrCpy $INSTDIR $INSTDIR -1
  ${EndIf}
  ${GetFileName} $INSTDIR $R9
  ${If} $R9 != "${APP_FILENAME}"
    StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
  ${EndIf}
!macroend
!macro customInit
  !insertmacro ownFolder
!macroend
!macro customPageAfterChangeDir
  Page custom ownFolderPage
  Function ownFolderPage
    !insertmacro ownFolder
    Abort
  FunctionEnd
!macroend

; The installer keeps a copy of itself in %LOCALAPPDATA%\audit-tool-updater for an auto-updater, and its uninstaller
; leaves it there. This program has no auto-updater, so the copy is removed right after installing.
!macro customInstall
  Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
  RMDir "$LOCALAPPDATA\audit-tool-updater"
!macroend

; Added to the Windows installer (electron-builder nsis.include).

!macro customInstall
  ; An update keeps the shortcuts as they are, so a Start menu entry that went missing never came back. Windows needs
  ; it to list Dayjob in Start and search, and to show its notifications, so it is put back when it is not there.
  ${ifNot} ${FileExists} "$newStartMenuLink"
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  ${endIf}
  ; Tells Explorer the icons changed, so the shortcuts show the new icon instead of a cached one.
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

; Windows caches app icons by file path. Every install and update puts ZLI.exe at the same path, so
; without a refresh the taskbar and Start menu can keep showing the icon from an older install.
!include x64.nsh

!macro customInstall
  ; The installer is 32-bit; on 64-bit Windows it must reach the real System32 copy of ie4uinit.
  ${If} ${RunningX64}
    ${DisableX64FSRedirection}
  ${EndIf}
  nsExec::Exec '"$SYSDIR\ie4uinit.exe" -show'
  ${If} ${RunningX64}
    ${EnableX64FSRedirection}
  ${EndIf}
  ; SHCNE_ASSOCCHANGED tells Explorer to redraw the icons it shows.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

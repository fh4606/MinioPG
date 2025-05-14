!macro customHeader
  !system "echo '' > ${BUILD_RESOURCES_DIR}/customHeader"
!macroend

!macro customInit
  ; 自定义初始化代码
!macroend

!macro customInstall
  ; 自定义安装代码
  ; 确保桌面快捷方式使用正确的图标
  CreateShortcut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_NAME}.exe" "" "$INSTDIR\resources\app.asar.unpacked\build\icon.ico" 0
!macroend

!macro customUnInit
  ; 自定义卸载初始化代码
!macroend 
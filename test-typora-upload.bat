@echo off
setlocal enabledelayedexpansion

echo ===== MinioGP Typora上传测试脚本 =====

rem 创建测试图片
echo 创建测试图片...
copy "%windir%\System32\cmd.exe" "%TEMP%\test-image.png" >nul 2>&1
if not exist "%TEMP%\test-image.png" (
    echo 错误：无法创建测试图片
    exit /b 1
)

echo 测试图片已创建：%TEMP%\test-image.png

rem 获取脚本目录
set SCRIPT_DIR=%~dp0
echo 脚本目录：%SCRIPT_DIR%

rem 检查typora-upload.bat是否存在
if not exist "%SCRIPT_DIR%typora-upload.bat" (
    echo 错误：找不到typora-upload.bat
    exit /b 1
)

echo 找到typora-upload.bat：%SCRIPT_DIR%typora-upload.bat

echo 执行上传测试...
echo 命令："%SCRIPT_DIR%typora-upload.bat" "%TEMP%\test-image.png"

rem 执行上传
call "%SCRIPT_DIR%typora-upload.bat" "%TEMP%\test-image.png"
set EXIT_CODE=%errorlevel%

echo 上传命令退出代码：%EXIT_CODE%

echo 检查日志文件...
if exist "%SCRIPT_DIR%logs\typora-simple-log.txt" (
    echo 日志文件存在：%SCRIPT_DIR%logs\typora-simple-log.txt
    echo 日志内容（最后10行）：
    powershell -Command "Get-Content '%SCRIPT_DIR%logs\typora-simple-log.txt' -Tail 10"
) else if exist "%TEMP%\MinioPG-logs\typora-simple-log.txt" (
    echo 日志文件存在（临时目录）：%TEMP%\MinioPG-logs\typora-simple-log.txt
    echo 日志内容（最后10行）：
    powershell -Command "Get-Content '%TEMP%\MinioPG-logs\typora-simple-log.txt' -Tail 10"
) else (
    echo 警告：找不到日志文件
)

echo 测试完成。

pause 
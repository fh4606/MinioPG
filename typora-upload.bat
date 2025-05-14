@echo off
setlocal enabledelayedexpansion

rem typora-upload.bat - 改进的Typora上传脚本

rem 创建日志目录（如果不存在）
set LOG_DIR=%~dp0logs
if not exist "%LOG_DIR%" (
    mkdir "%LOG_DIR%" 2>nul
    if errorlevel 1 (
        set LOG_DIR=%TEMP%\MinioPG-logs
        if not exist "!LOG_DIR!" mkdir "!LOG_DIR!" 2>nul
    )
)

rem 设置日志文件路径
set LOG_FILE=%LOG_DIR%\typora-simple-log.txt

rem 记录日志 - 使用UTF-8编码
echo %date% %time% ======== 开始处理Typora上传请求 ======== > "%LOG_FILE%"
echo %date% %time% 参数: %* >> "%LOG_FILE%"
echo %date% %time% 脚本路径: %~dp0 >> "%LOG_FILE%"
echo %date% %time% 日志目录: %LOG_DIR% >> "%LOG_FILE%"

rem 检查参数是否为空
if "%~1"=="" (
    echo %date% %time% 错误: 未提供文件路径参数 >> "%LOG_FILE%"
    echo 错误: 未提供文件路径参数
    exit /b 1
)

rem 检查是否是Typora传递的$FILE参数（未替换的变量）
if "%~1"=="$FILE" (
    echo %date% %time% 错误: Typora没有替换$FILE变量，请检查Typora设置 >> "%LOG_FILE%"
    echo 错误: Typora没有替换$FILE变量，请检查Typora设置
    exit /b 1
)

rem 直接使用第一个参数作为文件路径，去除可能的引号
set "FILE_PATH=%~1"
echo %date% %time% 文件路径: %FILE_PATH% >> "%LOG_FILE%"

rem 检查文件是否存在
if not exist "%FILE_PATH%" (
    echo %date% %time% 错误: 文件不存在 %FILE_PATH% >> "%LOG_FILE%"
    echo 错误: 文件不存在
    exit /b 1
)

rem 确定应用程序根目录
set "APP_ROOT=%~dp0"
echo %date% %time% 应用程序根目录: %APP_ROOT% >> "%LOG_FILE%"

rem 检查是否在打包环境中
if exist "%APP_ROOT%\..\resources\app.asar" (
    echo %date% %time% 检测到打包环境 >> "%LOG_FILE%"
    set "IS_PACKAGED=true"
) else (
    echo %date% %time% 检测到开发环境 >> "%LOG_FILE%"
    set "IS_PACKAGED=false"
)

rem 获取upgit路径 - 根据环境确定路径
if "%IS_PACKAGED%"=="true" (
    set "UPGIT_PATH=%APP_ROOT%upgit\upgit_win_amd64.exe"
    set "CONFIG_PATH=%APP_ROOT%upgit\config.toml"
) else (
    set "UPGIT_PATH=%APP_ROOT%upgit\upgit_win_amd64.exe"
    set "CONFIG_PATH=%APP_ROOT%upgit\config.toml"
)

echo %date% %time% 初始upgit路径: "%UPGIT_PATH%" >> "%LOG_FILE%"
echo %date% %time% 初始配置路径: "%CONFIG_PATH%" >> "%LOG_FILE%"

rem 检查upgit是否存在，如果不存在，尝试其他可能的位置
if not exist "%UPGIT_PATH%" (
    echo %date% %time% 未找到upgit: %UPGIT_PATH% >> "%LOG_FILE%"
    
    rem 尝试在resources目录中查找
    if "%IS_PACKAGED%"=="true" (
        rem 尝试在resources目录
        set "UPGIT_PATH=%APP_ROOT%..\upgit\upgit_win_amd64.exe"
        set "CONFIG_PATH=%APP_ROOT%..\upgit\config.toml"
        echo %date% %time% 尝试resources目录: %UPGIT_PATH% >> "%LOG_FILE%"
        
        if not exist "%UPGIT_PATH%" (
            set "UPGIT_PATH=%APP_ROOT%..\resources\upgit\upgit_win_amd64.exe"
            set "CONFIG_PATH=%APP_ROOT%..\resources\upgit\config.toml"
            echo %date% %time% 尝试resources子目录: %UPGIT_PATH% >> "%LOG_FILE%"
        )
    )
    
    if not exist "%UPGIT_PATH%" (
        rem 列出当前目录下的所有文件和文件夹
        echo %date% %time% 列出当前目录内容: >> "%LOG_FILE%"
        dir "%APP_ROOT%" >> "%LOG_FILE%" 2>&1
        
        rem 列出上级目录
        echo %date% %time% 列出上级目录内容: >> "%LOG_FILE%"
        dir "%APP_ROOT%..\" >> "%LOG_FILE%" 2>&1
        
        rem 如果存在resources目录，列出其内容
        if exist "%APP_ROOT%..\resources" (
            echo %date% %time% 列出resources目录内容: >> "%LOG_FILE%"
            dir "%APP_ROOT%..\resources" >> "%LOG_FILE%" 2>&1
        )
        
        echo %date% %time% 无法找到upgit可执行文件 >> "%LOG_FILE%"
        echo 错误：无法找到upgit可执行文件
        exit /b 1
    )
)

rem 检查config.toml是否存在
if not exist "%CONFIG_PATH%" (
    echo %date% %time% 配置文件不存在: %CONFIG_PATH% >> "%LOG_FILE%"
    
    rem 尝试在其他位置查找配置文件
    if exist "%APP_ROOT%upgit\config.toml" (
        set "CONFIG_PATH=%APP_ROOT%upgit\config.toml"
        echo %date% %time% 找到配置文件: %CONFIG_PATH% >> "%LOG_FILE%"
    ) else if exist "%APP_ROOT%config.toml" (
        set "CONFIG_PATH=%APP_ROOT%config.toml"
        echo %date% %time% 找到配置文件: %CONFIG_PATH% >> "%LOG_FILE%"
    ) else if exist "%APP_ROOT%..\resources\upgit\config.toml" (
        set "CONFIG_PATH=%APP_ROOT%..\resources\upgit\config.toml"
        echo %date% %time% 找到配置文件: %CONFIG_PATH% >> "%LOG_FILE%"
    ) else if exist "%APP_ROOT%..\upgit\config.toml" (
        set "CONFIG_PATH=%APP_ROOT%..\upgit\config.toml"
        echo %date% %time% 找到配置文件: %CONFIG_PATH% >> "%LOG_FILE%"
    ) else (
        echo %date% %time% 无法找到配置文件 >> "%LOG_FILE%"
        echo 错误：无法找到配置文件
        exit /b 1
    )
)

rem 创建临时文件存储输出
set "TEMP_OUTPUT=%TEMP%\upgit-output-%RANDOM%.txt"

rem 执行upgit命令 - 使用引号括起所有路径，避免空格问题
echo %date% %time% 执行命令: "%UPGIT_PATH%" "%FILE_PATH%" -c "%CONFIG_PATH%" >> "%LOG_FILE%"

rem 直接执行命令并将输出写入临时文件
"%UPGIT_PATH%" "%FILE_PATH%" -c "%CONFIG_PATH%" > "%TEMP_OUTPUT%" 2>&1
set EXIT_CODE=%errorlevel%

echo %date% %time% 命令执行完成，退出代码: %EXIT_CODE% >> "%LOG_FILE%"

rem 读取临时文件内容
echo %date% %time% 命令输出: >> "%LOG_FILE%"
type "%TEMP_OUTPUT%" >> "%LOG_FILE%"

rem 查找URL
set URL=
for /F "usebackq tokens=*" %%i in ("%TEMP_OUTPUT%") do (
    echo %%i | findstr /i "http://" > nul
    if not errorlevel 1 (
        set "URL=%%i"
        echo %date% %time% 找到URL: %%i >> "%LOG_FILE%"
    ) else (
        echo %%i | findstr /i "https://" > nul
        if not errorlevel 1 (
            set "URL=%%i"
            echo %date% %time% 找到URL: %%i >> "%LOG_FILE%"
        )
    )
)

rem 删除临时文件
del "%TEMP_OUTPUT%" 2>nul

rem 如果找到了URL，输出它
if defined URL (
    echo %date% %time% 上传成功，返回URL: %URL% >> "%LOG_FILE%"
    echo %URL%
    exit /b 0
) else (
    echo %date% %time% 上传失败，未找到URL >> "%LOG_FILE%"
    echo 上传失败，未找到URL
    exit /b 1
) 
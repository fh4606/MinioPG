const { app, BrowserWindow, ipcMain, dialog, clipboard, nativeImage, screen, shell } = require('electron');
const path = require('path');
const Store = require('electron-store');
const fs = require('fs');
const https = require('https');
const http = require('http');
const os = require('os');

// 初始化配置存储
const store = new Store({
  name: 'MinioPG-config'
});

// 记录配置文件路径
const configPath = store.path;
console.log('配置文件路径:', configPath);

// 初始化日志目录和文件
function initLogger() {
  try {
    // 使用应用程序的用户数据目录来存储日志
    const userDataPath = app.getPath('userData');
    const logDir = path.join(userDataPath, 'logs');
    
    // 确保日志目录存在
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    // 创建日志文件
    const today = new Date().toISOString().split('T')[0];
    const logFile = path.join(logDir, `${today}.log`);
    
    // 测试日志文件是否可写
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] [INFO] 日志系统初始化\n`);
    
    return {
      writeLog: function(level, message, error = null) {
        try {
          const timestamp = new Date().toISOString();
          let logMessage = `[${timestamp}] [${level}] ${message}`;
          if (error) {
            logMessage += `\nError: ${error.message}\nStack: ${error.stack}`;
          }
          logMessage += '\n';
          
          fs.appendFileSync(logFile, logMessage, 'utf8');
          console.log(logMessage);
        } catch (err) {
          console.error('写入日志失败:', err);
        }
      }
    };
  } catch (err) {
    console.error('初始化日志系统失败:', err);
    return {
      writeLog: function(level, message, error = null) {
        console.log(`[${level}] ${message}`, error);
      }
    };
  }
}

// 创建日志记录器实例
const logger = initLogger();

try {
  // 检查配置文件目录权限
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
    console.log('创建配置目录:', configDir);
  }
  
  // 检查文件是否可写
  const testFile = path.join(configDir, 'test-write.txt');
  fs.writeFileSync(testFile, 'test', { encoding: 'utf8' });
  fs.unlinkSync(testFile);
  console.log('配置目录写入权限测试成功');
} catch (error) {
  console.error('配置目录权限测试失败:', error);
}

let mainWindow = null;
let floatingWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 815,
    height: 520,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, 'build/icon.ico')
  });
  mainWindow.setMenuBarVisibility(false);

  // 加载 index.html
  mainWindow.loadFile('index.html');
  logger.writeLog('INFO', '主窗口创建成功');

  // 开发环境下打开开发者工具
  if (process.argv.includes('--debug')) {
    mainWindow.webContents.openDevTools();
    logger.writeLog('INFO', '开发者工具已打开');
  }
}

// 创建悬浮窗
function createFloatingWindow() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  
  floatingWindow = new BrowserWindow({
    width: 60,
    height: 60,
    x: width - 80, // 默认位置在右侧
    y: height - 80, // 默认位置在底部
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    transparent: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, 'build/icon.ico')
  });

  floatingWindow.loadFile('floating.html');
  logger.writeLog('INFO', '悬浮窗创建成功');

  // 允许拖动
  floatingWindow.setMovable(true);

  // 监听悬浮窗关闭事件
  floatingWindow.on('closed', () => {
    floatingWindow = null;
  });
}

// 处理切换到悬浮窗的请求
ipcMain.handle('toggle-floating-mode', () => {
  if (floatingWindow) {
    // 如果悬浮窗存在，则恢复主窗口
    if (mainWindow === null) {
      createWindow();
    }
    mainWindow.show();
    floatingWindow.close();
    floatingWindow = null;
    logger.writeLog('INFO', '切换到主窗口模式');
  } else {
    // 隐藏主窗口并创建悬浮窗
    mainWindow.hide();
    createFloatingWindow();
    logger.writeLog('INFO', '切换到悬浮窗模式');
  }
});

// 处理从悬浮窗恢复主窗口的请求
ipcMain.handle('restore-main-window', () => {
  if (mainWindow === null) {
    createWindow();
  }
  mainWindow.show();
  if (floatingWindow) {
    floatingWindow.close();
    floatingWindow = null;
  }
  logger.writeLog('INFO', '从悬浮窗恢复主窗口');
});

app.whenReady().then(() => {
  logger.writeLog('INFO', 'Application started');
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// 处理文件选择
ipcMain.handle('select-files', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择图片文件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }
    ]
  });
  return result.filePaths;
});

// 处理配置保存
ipcMain.handle('save-config', (event, config) => {
  try {
    // 确保配置对象是可序列化的
    const configStr = JSON.stringify(config);
    const parsedConfig = JSON.parse(configStr);
    
    console.log('保存配置:', configStr);
    store.set('config', parsedConfig);
    return true;
  } catch (error) {
    console.error('保存配置失败:', error);
    throw new Error(`保存配置失败: ${error.message}`);
  }
});

// 处理配置读取
ipcMain.handle('get-config', () => {
  try {
    const config = store.get('config');
    console.log('读取配置:', config ? JSON.stringify(config) : '无配置');
    return config;
  } catch (error) {
    console.error('读取配置失败:', error);
    throw new Error(`读取配置失败: ${error.message}`);
  }
});

// 获取配置文件路径
ipcMain.handle('get-config-path', () => {
  return {
    configPath,
    configDir: path.dirname(configPath),
    userDataPath: app.getPath('userData'),
    appPath: app.getAppPath()
  };
});

// 清除配置
ipcMain.handle('clear-config', () => {
  try {
    store.clear();
    console.log('配置已清除');
    return true;
  } catch (error) {
    console.error('清除配置失败:', error);
    throw new Error(`清除配置失败: ${error.message}`);
  }
});

// 将下载功能抽取为独立函数
async function downloadFromUrl(url) {
  logger.writeLog('INFO', `开始从URL下载图片: ${url}`);
  return new Promise((resolve, reject) => {
    try {
      const client = url.startsWith('https') ? https : http;
      logger.writeLog('DEBUG', `使用协议: ${url.startsWith('https') ? 'HTTPS' : 'HTTP'}`);

      const request = client.get(url, {
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      }, (response) => {
        if (response.statusCode !== 200) {
          const error = new Error(`HTTP Error: ${response.statusCode}`);
          logger.writeLog('ERROR', '下载失败: HTTP状态码错误', error);
          reject(error);
          return;
        }

        const contentType = response.headers['content-type'];
        logger.writeLog('DEBUG', `响应Content-Type: ${contentType}`);
        
        if (!contentType || !contentType.startsWith('image/')) {
          const error = new Error('URL不是图片');
          logger.writeLog('ERROR', '下载失败: 非图片类型', error);
          reject(error);
          return;
        }

        const extension = contentType.split('/')[1] || 'png';
        const tempDir = path.join(os.tmpdir(), 'MinioPG');
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }

        const timestamp = Date.now();
        const fileName = `url-${timestamp}.${extension}`;
        const filePath = path.join(tempDir, fileName);
        logger.writeLog('DEBUG', `临时文件路径: ${filePath}`);

        const fileStream = fs.createWriteStream(filePath);
        
        response.setTimeout(30000, () => {
          fileStream.close();
          fs.unlink(filePath, () => {});
          const error = new Error('下载超时');
          logger.writeLog('ERROR', '下载失败: 响应超时', error);
          reject(error);
        });

        response.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close();
          logger.writeLog('INFO', `图片下载成功: ${filePath}`);
          resolve(filePath);
        });

        fileStream.on('error', (err) => {
          fileStream.close();
          fs.unlink(filePath, () => {});
          const error = new Error(`文件写入失败: ${err.message}`);
          logger.writeLog('ERROR', '下载失败: 文件写入错误', error);
          reject(error);
        });
      });

      request.on('error', (err) => {
        const error = new Error(`网络请求失败: ${err.message}`);
        logger.writeLog('ERROR', '下载失败: 网络请求错误', error);
        reject(error);
      });

      request.on('timeout', () => {
        request.destroy();
        const error = new Error('请求超时');
        logger.writeLog('ERROR', '下载失败: 请求超时', error);
        reject(error);
      });
    } catch (error) {
      logger.writeLog('ERROR', '下载过程中发生未知错误', error);
      reject(error);
    }
  });
}

// 修改剪贴板处理
ipcMain.handle('upload-clipboard', async () => {
  logger.writeLog('INFO', '开始处理剪贴板内容');
  try {
    const clipboardText = clipboard.readText().trim();
    logger.writeLog('DEBUG', `剪贴板文本内容: ${clipboardText}`);
    
    if (clipboardText && (clipboardText.startsWith('http://') || clipboardText.startsWith('https://'))) {
      logger.writeLog('INFO', '检测到剪贴板中包含URL，尝试作为图片URL处理');
      try {
        const imagePath = await downloadFromUrl(clipboardText);
        logger.writeLog('INFO', `URL图片下载成功: ${imagePath}`);
        return imagePath;
      } catch (error) {
        logger.writeLog('ERROR', 'URL处理失败，尝试其他方式', error);
      }
    }

    const image = clipboard.readImage();
    if (image.isEmpty()) {
      const error = new Error('剪贴板中没有图片');
      logger.writeLog('ERROR', '剪贴板处理失败: 没有图片内容', error);
      throw error;
    }

    const tempDir = path.join(os.tmpdir(), 'MinioPG');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const timestamp = Date.now();
    const imagePath = path.join(tempDir, `clipboard-${timestamp}.png`);
    fs.writeFileSync(imagePath, image.toPNG());
    logger.writeLog('INFO', `剪贴板图片保存成功: ${imagePath}`);

    return imagePath;
  } catch (error) {
    logger.writeLog('ERROR', '剪贴板处理失败', error);
    throw error;
  }
});

// 处理URL上传处理
ipcMain.handle('uploadByUrl', async (event, url) => {
  logger.writeLog('INFO', `收到URL上传请求: ${url}`);
  try {
    const imagePath = await downloadFromUrl(url);
    logger.writeLog('INFO', `URL图片下载成功: ${imagePath}`);
    return imagePath;
  } catch (error) {
    logger.writeLog('ERROR', 'URL上传失败', error);
    throw error;
  }
});

// 处理外部链接
ipcMain.handle('open-external-link', async (event, url) => {
  try {
    await shell.openExternal(url);
    return true;
  } catch (error) {
    console.error('打开外部链接失败:', error);
    return false;
  }
});

// 处理命令行参数
const handleCliUpload = async (imagePath) => {
  try {
    // 获取配置
    const config = store.get('config');
    if (!config) {
      console.error('未找到配置信息');
      app.exit(1);
      return;
    }

    // 这里应该调用你的上传函数
    // 为了示例，我们假设上传函数返回一个URL
    const uploadResult = await uploadImage(imagePath, config);
    
    // PicGo 格式的输出
    console.log(uploadResult.url);
    app.exit(0);
  } catch (error) {
    console.error('上传失败:', error);
    app.exit(1);
  }
};

// 检查是否是命令行上传模式
const isCliUpload = process.argv.length > 1 && process.argv[1] !== '.' && process.argv[1] !== '--inspect';

if (isCliUpload) {
  const imagePath = process.argv[1];
  if (!fs.existsSync(imagePath)) {
    console.error('文件不存在:', imagePath);
    app.exit(1);
  } else {
    app.whenReady().then(() => handleCliUpload(imagePath));
  }
} else {
  // 原有的GUI模式代码
  // ... existing code ...
} 
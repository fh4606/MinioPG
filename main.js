const { app, BrowserWindow, ipcMain, dialog, clipboard, nativeImage, screen, shell, Tray, Menu } = require('electron');
const path = require('path');
const Store = require('electron-store');
const fs = require('fs');
const https = require('https');
const http = require('http');
const os = require('os');
const url = require('url');

// 初始化配置存储
const store = new Store({
  name: 'MinioPG-config'
});

// 标志变量，控制是否允许应用退出
let forceQuit = false;

// 记录配置文件路径
const configPath = store.path;
console.log('配置文件路径:', configPath);

// 创建HTTP服务器，用于与Typora对接
let httpServer = null;
let isHttpServerRunning = false;

// 初始化HTTP服务器
function initHttpServer() {
  if (isHttpServerRunning) return;
  
  httpServer = http.createServer(async (req, res) => {
    logger.writeLog('INFO', `收到HTTP请求: ${req.method} ${req.url}`);
    
    // 设置CORS头，允许跨域请求
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // 处理OPTIONS请求（预检请求）
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }
    
    // 只处理/upload路径的POST请求
    if (req.method === 'POST' && req.url === '/upload') {
      try {
        // 获取配置
        const config = store.get('config');
        if (!config || !config.minio) {
          logger.writeLog('ERROR', '未找到有效的MinIO配置');
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '未找到有效的MinIO配置' }));
          return;
        }
        
        // 处理文件上传
        const contentType = req.headers['content-type'] || '';
        logger.writeLog('INFO', `上传内容类型: ${contentType}`);
        
        // 处理multipart/form-data请求
        if (contentType.includes('multipart/form-data')) {
          let body = [];
          let boundary = contentType.split('boundary=')[1];
          
          // 如果boundary包含双引号，需要去除
          if (boundary && boundary.startsWith('"') && boundary.endsWith('"')) {
            boundary = boundary.slice(1, -1);
          }
          
          if (!boundary) {
            logger.writeLog('ERROR', '无法解析multipart/form-data边界');
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: '无法解析multipart/form-data边界' }));
            return;
          }
          
          logger.writeLog('INFO', `解析到boundary: ${boundary}`);
          
          req.on('data', (chunk) => {
            body.push(chunk);
            logger.writeLog('DEBUG', `收到数据块: ${chunk.length} 字节`);
          });
          
          req.on('end', async () => {
            try {
              const buffer = Buffer.concat(body);
              logger.writeLog('INFO', `接收到总数据: ${buffer.length} 字节`);
              
              const files = await parseMultipart(buffer, boundary);
              logger.writeLog('INFO', `解析到 ${files.length} 个文件`);
              
              if (files.length === 0) {
                logger.writeLog('ERROR', '未找到上传的文件');
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: '未找到上传的文件' }));
                return;
              }
              
              // 处理上传的文件
              const uploadResults = [];
              
              for (const file of files) {
                try {
                  logger.writeLog('INFO', `处理文件: ${file.filename}, 大小: ${file.data.length} 字节`);
                  
                  // 保存临时文件
                  const tempDir = path.join(os.tmpdir(), 'MinioPG');
                  if (!fs.existsSync(tempDir)) {
                    fs.mkdirSync(tempDir, { recursive: true });
                  }
                  
                  const timestamp = Date.now();
                  const tempFilePath = path.join(tempDir, `${timestamp}-${file.filename}`);
                  fs.writeFileSync(tempFilePath, file.data);
                  logger.writeLog('INFO', `临时文件已保存: ${tempFilePath}`);
                  
                  // 上传到MinIO
                  const uploadResult = await uploadToMinio(tempFilePath, config);
                  uploadResults.push(uploadResult);
                  logger.writeLog('INFO', `文件已上传到MinIO: ${uploadResult.url}`);
                  
                  // 删除临时文件
                  fs.unlinkSync(tempFilePath);
                } catch (error) {
                  logger.writeLog('ERROR', `处理文件 ${file.filename} 失败: ${error.message}`, error);
                  uploadResults.push({
                    success: false,
                    filename: file.filename,
                    message: error.message
                  });
                }
              }
              
              // 返回上传结果
              const resultUrls = uploadResults.filter(r => r.success).map(r => r.url);
              logger.writeLog('INFO', `返回上传结果: ${JSON.stringify(resultUrls)}`);
              
              res.writeHead(200, { 'Content-Type': 'application/json' });
              
              // Typora期望的响应格式
              const typoraResponse = {
                success: resultUrls.length > 0,
                msg: resultUrls.length > 0 ? "上传成功" : "上传失败",
                result: resultUrls
              };
              
              res.end(JSON.stringify(typoraResponse));
            } catch (error) {
              logger.writeLog('ERROR', `处理上传请求失败: ${error.message}`, error);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, message: error.message }));
            }
          });
        } else {
          // 处理直接的文件数据
          let body = [];
          
          req.on('data', (chunk) => {
            body.push(chunk);
            logger.writeLog('DEBUG', `收到数据块: ${chunk.length} 字节`);
          });
          
          req.on('end', async () => {
            try {
              const buffer = Buffer.concat(body);
              logger.writeLog('INFO', `接收到总数据: ${buffer.length} 字节`);
              
              // 保存临时文件
              const tempDir = path.join(os.tmpdir(), 'MinioPG');
              if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
              }
              
              const timestamp = Date.now();
              const tempFilePath = path.join(tempDir, `${timestamp}.png`); // 默认为PNG
              fs.writeFileSync(tempFilePath, buffer);
              logger.writeLog('INFO', `临时文件已保存: ${tempFilePath}`);
              
              // 上传到MinIO
              const uploadResult = await uploadToMinio(tempFilePath, config);
              logger.writeLog('INFO', `文件已上传到MinIO: ${uploadResult.url}`);
              
              // 删除临时文件
              fs.unlinkSync(tempFilePath);
              
              // 返回上传结果
              res.writeHead(200, { 'Content-Type': 'application/json' });
              
              // Typora期望的响应格式
              const typoraResponse = {
                success: true,
                msg: "上传成功",
                result: [uploadResult.url]
              };
              
              res.end(JSON.stringify(typoraResponse));
            } catch (error) {
              logger.writeLog('ERROR', `处理上传请求失败: ${error.message}`, error);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, message: error.message }));
            }
          });
        }
      } catch (error) {
        logger.writeLog('ERROR', `处理上传请求失败: ${error.message}`, error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: error.message }));
      }
    } else {
      // 其他请求返回404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: '请求的资源不存在' }));
    }
  });
  
  // 监听端口
  httpServer.listen(36677, '127.0.0.1', () => {
    isHttpServerRunning = true;
    logger.writeLog('INFO', 'HTTP服务器已启动，监听端口: 36677');
  });
  
  // 错误处理
  httpServer.on('error', (error) => {
    isHttpServerRunning = false;
    logger.writeLog('ERROR', `HTTP服务器启动失败: ${error.message}`, error);
    
    // 如果端口被占用，尝试关闭已存在的服务
    if (error.code === 'EADDRINUSE') {
      logger.writeLog('INFO', '端口36677已被占用，尝试关闭现有服务...');
      
      // 尝试请求已存在的服务关闭
      const request = http.request({
        host: '127.0.0.1',
        port: 36677,
        path: '/shutdown',
        method: 'POST'
      }, (response) => {
        logger.writeLog('INFO', '已请求现有服务关闭，稍后将重试');
        setTimeout(() => {
          initHttpServer();
        }, 1000);
      });
      
      request.on('error', (err) => {
        logger.writeLog('ERROR', '无法请求现有服务关闭', err);
      });
      
      request.end();
    }
  });
}

// 解析multipart/form-data请求
async function parseMultipart(buffer, boundary) {
  const files = [];
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const endBoundaryBuffer = Buffer.from(`--${boundary}--`);
  
  logger.writeLog('DEBUG', `开始解析multipart数据，boundary: ${boundary}`);
  
  let start = 0;
  let end = buffer.indexOf(boundaryBuffer, start);
  
  while (end !== -1) {
    // 移动到边界后面
    start = end + boundaryBuffer.length + 2; // +2 for CRLF
    
    // 查找下一个边界
    end = buffer.indexOf(boundaryBuffer, start);
    if (end === -1) {
      // 查找结束边界
      end = buffer.indexOf(endBoundaryBuffer, start);
      if (end === -1) break;
    }
    
    // 解析部分内容
    const partBuffer = buffer.slice(start, end - 2); // -2 for CRLF
    
    // 查找头部和内容的分隔
    const headerEnd = partBuffer.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) {
      logger.writeLog('DEBUG', '无法找到头部和内容的分隔');
      continue;
    }
    
    // 解析头部
    const headerBuffer = partBuffer.slice(0, headerEnd);
    const headerStr = headerBuffer.toString('utf8');
    logger.writeLog('DEBUG', `解析到头部: ${headerStr}`);
    
    // 查找Content-Disposition头
    const contentDispositionMatch = headerStr.match(/Content-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]+)")?/i);
    if (!contentDispositionMatch) {
      logger.writeLog('DEBUG', '无法解析Content-Disposition头');
      continue;
    }
    
    const name = contentDispositionMatch[1];
    const filename = contentDispositionMatch[2] || 'unknown.png';
    logger.writeLog('DEBUG', `解析到文件: ${name}, ${filename}`);
    
    // 获取文件内容
    const fileData = partBuffer.slice(headerEnd + 4); // +4 for \r\n\r\n
    
    files.push({
      name,
      filename,
      data: fileData
    });
    
    logger.writeLog('DEBUG', `已添加文件: ${filename}, 大小: ${fileData.length} 字节`);
  }
  
  logger.writeLog('INFO', `解析完成，共找到 ${files.length} 个文件`);
  return files;
}

// 上传文件到MinIO
async function uploadToMinio(filePath, config) {
  return new Promise((resolve, reject) => {
    try {
      const Minio = require('minio');
      
      // 创建MinIO客户端
      const minioConfig = config.minio;
      const minioClient = new Minio.Client({
        endPoint: minioConfig.endpoint.replace(/^https?:\/\//, ''),
        port: parseInt(minioConfig.port) || 9000,
        useSSL: minioConfig.useSSL || minioConfig.endpoint.startsWith('https'),
        accessKey: minioConfig.accessKey,
        secretKey: minioConfig.secretKey
      });
      
      // 获取文件信息
      const fileName = path.basename(filePath);
      const fileStats = fs.statSync(filePath);
      const fileStream = fs.createReadStream(filePath);
      
      // 生成唯一的对象名称
      const timestamp = Date.now();
      let objectName;
      
      // 使用时间戳+原始文件名的命名规则
      objectName = `${timestamp}-${fileName}`;
      
      // 如果有当前上传路径，添加路径前缀
      if (config.currentUploadPath && config.currentUploadPath.trim() !== '') {
        const uploadPath = config.currentUploadPath.trim();
        objectName = uploadPath + (uploadPath.endsWith('/') ? '' : '/') + objectName;
      }
      
      logger.writeLog('INFO', `上传文件到MinIO: ${objectName}`);
      
      // 上传到MinIO
      minioClient.putObject(
        minioConfig.bucket,
        objectName,
        fileStream,
        fileStats.size
      ).then(() => {
        // 生成URL
        let fileUrl;
        if (minioConfig.domain) {
          fileUrl = `${minioConfig.domain}/${objectName}`;
        } else {
          const protocol = minioConfig.useSSL ? 'https' : 'http';
          fileUrl = `${protocol}://${minioConfig.endpoint}:${minioConfig.port}/${minioConfig.bucket}/${objectName}`;
        }
        
        logger.writeLog('INFO', `文件上传成功: ${fileUrl}`);
        
        resolve({
          success: true,
          url: fileUrl,
          filename: fileName
        });
      }).catch(error => {
        logger.writeLog('ERROR', `上传到MinIO失败: ${error.message}`, error);
        reject(error);
      });
    } catch (error) {
      logger.writeLog('ERROR', `创建MinIO客户端失败: ${error.message}`, error);
      reject(error);
    }
  });
}

// 关闭HTTP服务器
function closeHttpServer() {
  if (httpServer && isHttpServerRunning) {
    httpServer.close(() => {
      isHttpServerRunning = false;
      logger.writeLog('INFO', 'HTTP服务器已关闭');
    });
  }
}

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
let tray = null;

// 创建托盘图标
function createTray() {
  // 如果托盘已存在，则不重复创建
  if (tray) return;
  
  // 创建托盘图标
  let iconPath;
  if (app.isPackaged) {
    // 打包环境
    iconPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'build', 'icon.ico');
    if (!fs.existsSync(iconPath)) {
      // 备选路径
      iconPath = path.join(process.resourcesPath, 'build', 'icon.ico');
      if (!fs.existsSync(iconPath)) {
        iconPath = path.join(__dirname, 'build', 'icon.ico');
      }
    }
  } else {
    // 开发环境
    iconPath = path.join(__dirname, 'build', 'icon.ico');
  }
  
  logger.writeLog('INFO', `使用托盘图标路径: ${iconPath}`);
  tray = new Tray(iconPath);
  
  // 设置托盘图标提示文字
  tray.setToolTip('MinioPG');
  
  // 创建托盘菜单
  const contextMenu = Menu.buildFromTemplate([
    { 
      label: '显示主窗口', 
      click: () => {
        if (mainWindow) {
          mainWindow.show();
        } else {
          createWindow();
        }
      } 
    },
    { type: 'separator' },
    { 
      label: '退出', 
      click: () => {
        forceQuit = true;
        app.quit();
      } 
    }
  ]);
  
  // 设置托盘上下文菜单
  tray.setContextMenu(contextMenu);
  
  // 点击托盘图标时显示主窗口
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
    } else {
      createWindow();
    }
  });
  
  logger.writeLog('INFO', '托盘图标创建成功');
}

function createWindow() {
  // 确定图标路径
  let iconPath;
  if (app.isPackaged) {
    // 打包环境
    iconPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'build', 'icon.ico');
    if (!fs.existsSync(iconPath)) {
      // 备选路径
      iconPath = path.join(process.resourcesPath, 'build', 'icon.ico');
      if (!fs.existsSync(iconPath)) {
        iconPath = path.join(__dirname, 'build', 'icon.ico');
      }
    }
  } else {
    // 开发环境
    iconPath = path.join(__dirname, 'build', 'icon.ico');
  }
  
  logger.writeLog('INFO', `使用图标路径: ${iconPath}`);
  
  mainWindow = new BrowserWindow({
    width: 815,
    height: 520,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: iconPath
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
  
  // 处理窗口关闭事件
  mainWindow.on('close', (event) => {
    // 如果不是强制退出，则阻止默认的关闭行为
    if (!forceQuit) {
      event.preventDefault();
      
      // 发送消息给渲染进程，询问用户选择
      mainWindow.webContents.send('app-close-prompt');
      
      logger.writeLog('INFO', '触发关闭提示');
    } else {
      logger.writeLog('INFO', '应用程序正在退出');
    }
  });
}

// 创建悬浮窗
function createFloatingWindow() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  
  // 确定图标路径
  let iconPath;
  if (app.isPackaged) {
    // 打包环境
    iconPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'build', 'icon.ico');
    if (!fs.existsSync(iconPath)) {
      // 备选路径
      iconPath = path.join(process.resourcesPath, 'build', 'icon.ico');
      if (!fs.existsSync(iconPath)) {
        iconPath = path.join(__dirname, 'build', 'icon.ico');
      }
    }
  } else {
    // 开发环境
    iconPath = path.join(__dirname, 'build', 'icon.ico');
  }
  
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
    icon: iconPath
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

// 应用程序准备就绪
app.whenReady().then(async () => {
  // 创建主窗口
  createWindow();
  
  // 加载配置并生成upgit配置文件
  const config = await loadConfig();
  if (config) {
    await generateUpgitConfig(config);
  }
  
  // 创建托盘图标
  createTray();
  
  // 启动HTTP服务器
  initHttpServer();
  
  console.log('[INFO] Application started\n');
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    // 如果不是强制退出，且托盘图标存在，则不退出应用
    if (!forceQuit && tray) {
      return;
    }
    app.quit();
  }
});

// 应用退出前清理托盘图标和HTTP服务器
app.on('before-quit', () => {
  if (tray) {
    tray.destroy();
    tray = null;
  }
  
  // 关闭HTTP服务器
  closeHttpServer();
});

// 处理文件选择
ipcMain.handle('select-files', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择文件',
    properties: ['openFile', 'multiSelections']
  });
  return result.filePaths;
});

// 处理选择下载目录
ipcMain.handle('select-download-directory', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择下载目录',
    properties: ['openDirectory']
  });
  return result.filePaths && result.filePaths.length > 0 ? result.filePaths[0] : null;
});

// 处理文件下载
ipcMain.handle('download-file', async (event, options) => {
  const { url, bucket, objectName, downloadPath } = options;
  logger.writeLog('INFO', `开始下载文件: ${objectName} 到 ${downloadPath}`);
  
  try {
    // 获取配置
    const config = store.get('config');
    if (!config || !config.minio) {
      throw new Error('未找到有效的MinIO配置');
    }
    
    // 创建MinIO客户端
    const Minio = require('minio');
    const minioConfig = config.minio;
    const minioClient = new Minio.Client({
      endPoint: minioConfig.endpoint.replace(/^https?:\/\//, ''),
      port: parseInt(minioConfig.port) || 9000,
      useSSL: minioConfig.useSSL || minioConfig.endpoint.startsWith('https'),
      accessKey: minioConfig.accessKey,
      secretKey: minioConfig.secretKey
    });
    
    // 确保下载目录存在
    const downloadDir = path.dirname(downloadPath);
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }
    
    // 创建写入流
    const fileStream = fs.createWriteStream(downloadPath);
    
    // 将MinIO的getObject转换为Promise
    const dataStream = await minioClient.getObject(bucket, objectName);
    
    // 处理数据流
    return new Promise((resolve, reject) => {
      dataStream.on('data', (chunk) => {
        fileStream.write(chunk);
      });
      
      dataStream.on('end', () => {
        fileStream.end();
        logger.writeLog('INFO', `文件下载成功: ${downloadPath}`);
        resolve({ success: true, path: downloadPath });
      });
      
      dataStream.on('error', (err) => {
        fileStream.end();
        logger.writeLog('ERROR', `文件下载数据流错误: ${err.message}`, err);
        reject(err);
      });
      
      fileStream.on('error', (err) => {
        logger.writeLog('ERROR', `文件写入错误: ${err.message}`, err);
        reject(err);
      });
    });
  } catch (error) {
    logger.writeLog('ERROR', `下载文件失败: ${error.message}`, error);
    throw error;
  }
});

// 通过URL下载文件
ipcMain.handle('download-file-from-url', async (event, options) => {
  const { url, downloadPath } = options;
  logger.writeLog('INFO', `开始通过URL下载文件: ${url} 到 ${downloadPath}`);
  
  try {
    // 确保下载目录存在
    const downloadDir = path.dirname(downloadPath);
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }
    
    // 创建写入流
    const fileStream = fs.createWriteStream(downloadPath);
    
    // 根据URL选择协议
    const client = url.startsWith('https') ? https : http;
    
    // 通过URL下载文件
    return new Promise((resolve, reject) => {
      const request = client.get(url, {
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      }, (response) => {
        if (response.statusCode !== 200) {
          const error = new Error(`HTTP Error: ${response.statusCode}`);
          logger.writeLog('ERROR', '下载失败: HTTP状态码错误', error);
          fileStream.close();
          try {
            if (fs.existsSync(downloadPath)) {
              fs.unlinkSync(downloadPath);
            }
          } catch (e) {
            logger.writeLog('ERROR', `删除失败的下载文件失败: ${e.message}`, e);
          }
          reject(error);
          return;
        }
        
        response.pipe(fileStream);
        
        fileStream.on('finish', () => {
          fileStream.close();
          logger.writeLog('INFO', `通过URL下载文件成功: ${downloadPath}`);
          resolve({ success: true, path: downloadPath });
        });
      });
      
      request.on('error', (err) => {
        fileStream.close();
        try {
          if (fs.existsSync(downloadPath)) {
            fs.unlinkSync(downloadPath);
          }
        } catch (e) {
          logger.writeLog('ERROR', `删除失败的下载文件失败: ${e.message}`, e);
        }
        logger.writeLog('ERROR', `通过URL下载文件失败: ${err.message}`, err);
        reject(err);
      });
      
      request.on('timeout', () => {
        request.destroy();
        fileStream.close();
        try {
          if (fs.existsSync(downloadPath)) {
            fs.unlinkSync(downloadPath);
          }
        } catch (e) {
          logger.writeLog('ERROR', `删除失败的下载文件失败: ${e.message}`, e);
        }
        const error = new Error('请求超时');
        logger.writeLog('ERROR', '通过URL下载文件失败: 请求超时', error);
        reject(error);
      });
    });
  } catch (error) {
    logger.writeLog('ERROR', `通过URL下载文件失败: ${error.message}`, error);
    throw error;
  }
});

// 打开目录
ipcMain.handle('open-directory', async (event, dirPath) => {
  try {
    await shell.openPath(dirPath);
    return true;
  } catch (error) {
    logger.writeLog('ERROR', `打开目录失败: ${error.message}`, error);
    return false;
  }
});

// 获取配置
ipcMain.handle('get-config', async () => {
  return await loadConfig();
});

// 保存配置
ipcMain.handle('save-config', async (event, config) => {
  return await saveConfig(config);
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
  logger.writeLog('INFO', `开始从URL下载文件: ${url}`);
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

        const contentType = response.headers['content-type'] || '';
        logger.writeLog('DEBUG', `响应Content-Type: ${contentType}`);
        
        // 根据Content-Type或URL确定文件扩展名
        let extension = 'bin';  // 默认二进制文件扩展名
        
        if (contentType) {
          const mimeToExt = {
            'image/jpeg': 'jpg',
            'image/png': 'png',
            'image/gif': 'gif',
            'image/webp': 'webp',
            'image/bmp': 'bmp',
            'application/pdf': 'pdf',
            'application/zip': 'zip',
            'application/x-rar-compressed': 'rar',
            'text/plain': 'txt',
            'text/html': 'html',
            'text/css': 'css',
            'text/javascript': 'js',
            'application/json': 'json',
            'application/xml': 'xml',
            'application/msword': 'doc',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
            'application/vnd.ms-excel': 'xls',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx'
          };
          
          const mainType = contentType.split(';')[0].trim();
          extension = mimeToExt[mainType] || extension;
        }
        
        // 如果URL中有文件名，尝试从中提取扩展名
        const urlFileName = url.split('/').pop().split('?')[0];
        if (urlFileName && urlFileName.includes('.')) {
          const urlExt = urlFileName.split('.').pop().toLowerCase();
          if (urlExt.length > 0 && urlExt.length < 5) {
            extension = urlExt;
          }
        }

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
          logger.writeLog('INFO', `文件下载成功: ${filePath}`);
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
    // 1. 首先检查是否有文本URL
    const clipboardText = clipboard.readText().trim();
    logger.writeLog('DEBUG', `剪贴板文本内容: ${clipboardText}`);
    
    if (clipboardText && (clipboardText.startsWith('http://') || clipboardText.startsWith('https://'))) {
      logger.writeLog('INFO', '检测到剪贴板中包含URL，尝试下载');
      try {
        const filePath = await downloadFromUrl(clipboardText);
        logger.writeLog('INFO', `URL文件下载成功: ${filePath}`);
        return filePath;
      } catch (error) {
        logger.writeLog('ERROR', 'URL处理失败，尝试其他方式', error);
      }
    }

    // 2. 检查剪贴板是否有文件路径
    try {
      const formats = clipboard.availableFormats();
      logger.writeLog('DEBUG', `剪贴板可用格式: ${formats.join(', ')}`);
      
      // 在Windows上检查是否有文件路径
      if (process.platform === 'win32' && formats.includes('text/plain')) {
        const text = clipboard.readText();
        // 检查是否是有效的文件路径
        if (text && !text.includes('\n') && fs.existsSync(text)) {
          logger.writeLog('INFO', `剪贴板包含有效文件路径: ${text}`);
          return text;
        }
      }
      
      // 检查是否有文件列表
      if (formats.includes('text/uri-list') || formats.some(f => f.includes('file'))) {
        try {
          // 尝试读取文件列表
          const filePaths = clipboard.readBuffer('FileNameW').toString('ucs2').replace(/\0/g, '').trim();
          if (filePaths && fs.existsSync(filePaths)) {
            logger.writeLog('INFO', `从剪贴板获取文件路径: ${filePaths}`);
            return filePaths;
          }
        } catch (fileError) {
          logger.writeLog('DEBUG', '尝试读取文件路径失败，继续其他方法', fileError);
        }
      }
    } catch (formatError) {
      logger.writeLog('DEBUG', '读取剪贴板格式失败', formatError);
    }

    // 3. 检查是否有图片
    const image = clipboard.readImage();
    if (!image.isEmpty()) {
      const tempDir = path.join(os.tmpdir(), 'MinioPG');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const timestamp = Date.now();
      const imagePath = path.join(tempDir, `clipboard-${timestamp}.png`);
      fs.writeFileSync(imagePath, image.toPNG());
      logger.writeLog('INFO', `剪贴板图片保存成功: ${imagePath}`);
      return imagePath;
    }
    
    // 4. 如果是纯文本内容，保存为文本文件
    if (clipboardText && clipboardText.length > 0) {
      const tempDir = path.join(os.tmpdir(), 'MinioPG');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const timestamp = Date.now();
      const textPath = path.join(tempDir, `clipboard-${timestamp}.txt`);
      fs.writeFileSync(textPath, clipboardText, 'utf8');
      logger.writeLog('INFO', `剪贴板文本保存成功: ${textPath}`);
      return textPath;
    }

    // 如果所有方法都失败
    const error = new Error('剪贴板中没有可用内容');
    logger.writeLog('ERROR', '剪贴板处理失败: 没有可用内容', error);
    throw error;
  } catch (error) {
    logger.writeLog('ERROR', '剪贴板处理失败', error);
    throw error;
  }
});

// 处理URL上传
ipcMain.handle('upload-url', async (event, url) => {
  logger.writeLog('INFO', '开始处理URL上传');
  try {
    const filePath = await downloadFromUrl(url);
    return filePath;
  } catch (error) {
    logger.writeLog('ERROR', 'URL上传处理失败', error);
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

// 处理退出应用程序的请求
ipcMain.handle('app-exit', () => {
  logger.writeLog('INFO', '用户选择退出应用');
  forceQuit = true;
  app.quit();
});

// 处理最小化到任务栏的请求
ipcMain.handle('app-minimize', () => {
  logger.writeLog('INFO', '用户选择最小化到任务栏');
  
  // 确保托盘图标存在
  if (!tray) {
    createTray();
  }
  
  if (mainWindow) {
    mainWindow.hide();
  }
});

// 获取当前上传路径
ipcMain.handle('get-upload-path', () => {
  const config = store.get('config');
  return config && config.currentUploadPath ? config.currentUploadPath : '';
});

// 设置当前上传路径
ipcMain.handle('set-upload-path', (event, path) => {
  const config = store.get('config') || {};
  config.currentUploadPath = path;
  store.set('config', config);
  return true;
});

// 获取应用程序路径
ipcMain.handle('get-app-path', async (event) => {
  // 在开发环境中返回当前目录
  // 在生产环境中返回extraResources目录
  if (app.isPackaged) {
    // 生产环境 - 使用extraResources目录
    return path.join(process.resourcesPath, 'app.asar.unpacked');
  } else {
    // 开发环境 - 使用当前目录
    return path.resolve(__dirname);
  }
});

// 生成upgit配置文件
async function generateUpgitConfig(config) {
  try {
    const fs = require('fs');
    const path = require('path');
    
    // 确定upgit目录的路径
    let upgitDir;
    let logMsg = '';
    
    if (app.isPackaged) {
      // 生产环境 - 尝试多个可能的位置
      const possiblePaths = [
        path.join(process.resourcesPath, 'upgit'),
        path.join(process.resourcesPath, 'app.asar.unpacked', 'upgit'),
        path.join(app.getAppPath(), '..', 'upgit'),
        path.join(app.getPath('exe'), '..', 'resources', 'upgit')
      ];
      
      logger.writeLog('INFO', `尝试在多个位置查找upgit目录 (打包环境)`);
      
      // 尝试所有可能的路径
      for (const testPath of possiblePaths) {
        logger.writeLog('INFO', `尝试路径: ${testPath}`);
        if (fs.existsSync(testPath)) {
          upgitDir = testPath;
          logger.writeLog('INFO', `找到upgit目录: ${upgitDir}`);
          break;
        }
      }
      
      // 如果没有找到，默认使用resources目录
      if (!upgitDir) {
        upgitDir = path.join(process.resourcesPath, 'upgit');
        logger.writeLog('WARN', `未找到upgit目录，使用默认路径: ${upgitDir}`);
      }
    } else {
      // 开发环境 - 使用当前目录
      upgitDir = path.join(__dirname, 'upgit');
      logger.writeLog('INFO', `使用开发环境upgit目录: ${upgitDir}`);
    }
    
    // 确保upgit目录存在
    if (!fs.existsSync(upgitDir)) {
      logger.writeLog('WARN', `upgit目录不存在: ${upgitDir}，尝试创建`);
      try {
        fs.mkdirSync(upgitDir, { recursive: true });
        logger.writeLog('INFO', `创建upgit目录: ${upgitDir}`);
      } catch (err) {
        logger.writeLog('ERROR', `创建upgit目录失败: ${err.message}`, err);
        
        // 尝试使用临时目录作为备用
        upgitDir = path.join(app.getPath('temp'), 'MinioPG-upgit');
        logger.writeLog('WARN', `尝试使用临时目录作为备用: ${upgitDir}`);
        
        try {
          if (!fs.existsSync(upgitDir)) {
            fs.mkdirSync(upgitDir, { recursive: true });
          }
          logger.writeLog('INFO', `使用临时目录: ${upgitDir}`);
        } catch (tempErr) {
          logger.writeLog('ERROR', `创建临时upgit目录也失败: ${tempErr.message}`, tempErr);
          return false;
        }
      }
    } else {
      logger.writeLog('INFO', `upgit目录已存在: ${upgitDir}`);
      
      // 列出upgit目录中的文件
      try {
        const files = fs.readdirSync(upgitDir);
        logger.writeLog('INFO', `upgit目录内容: ${files.join(', ')}`);
      } catch (err) {
        logger.writeLog('ERROR', `读取upgit目录内容失败: ${err.message}`, err);
      }
    }
    
    const upgitConfigPath = path.join(upgitDir, 'config.toml');
    logger.writeLog('INFO', `upgit配置文件路径: ${upgitConfigPath}`);
    
    // 检查配置文件目录是否可写
    try {
      fs.accessSync(upgitDir, fs.constants.W_OK);
      logger.writeLog('INFO', `upgit目录可写: ${upgitDir}`);
    } catch (err) {
      logger.writeLog('ERROR', `upgit目录不可写: ${err.message}`, err);
      
      // 尝试使用临时目录
      upgitDir = path.join(app.getPath('temp'), 'MinioPG-upgit');
      logger.writeLog('WARN', `切换到临时目录: ${upgitDir}`);
      
      if (!fs.existsSync(upgitDir)) {
        try {
          fs.mkdirSync(upgitDir, { recursive: true });
        } catch (mkdirErr) {
          logger.writeLog('ERROR', `创建临时目录失败: ${mkdirErr.message}`, mkdirErr);
          return false;
        }
      }
    }
    
    // 确保config中包含必要的Minio配置
    if (!config || !config.minio || !config.minio.endpoint || !config.minio.accessKey || !config.minio.secretKey) {
      logger.writeLog('ERROR', '无法生成upgit配置：缺少必要的Minio配置');
      return false;
    }
    
    // 构建endpoint URL
    let endpoint = config.minio.endpoint;
    if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
      endpoint = `http://${endpoint}`;
    }
    if (config.minio.port && config.minio.port !== 80 && config.minio.port !== 443) {
      endpoint = `${endpoint}:${config.minio.port}`;
    }
    
    // 构建URL格式
    let urlFormat;
    if (config.minio.domain) {
      // 当使用自定义域名时，不再包含{bucket}以避免重复桶名称
      urlFormat = `${config.minio.domain}/{path}`;
    } else {
      urlFormat = `${endpoint}/{bucket}/{path}`;
    }
    
    // 构建upgit配置文件内容
    const configContent = `# =============================================================================
# UPGIT 配置 - MinioGP集成 (自动生成)
# =============================================================================

# 默认上传器
default_uploader = "s3"

# 上传文件名的格式模板
rename = "upgit_{year}{month}{day}_{unix_ts}{ext}"

# -----------------------------------------------------------------------------
# 自定义输出格式
# -----------------------------------------------------------------------------
[output_formats]
"markdown" = "![{fname}{ext}]({url})"
"url" = "{url}"
"html" = '<img src="{url}" alt="{fname}" />'

# =============================================================================
# MinIO S3兼容配置
# =============================================================================
[uploaders.s3]
region = "us-east-1"
bucket_name = "${config.minio.bucket || 'www'}"
access_key = "${config.minio.accessKey}"
secret_key = "${config.minio.secretKey}"
endpoint = "${endpoint}"
url_format = "${urlFormat}"
`;

    // 写入配置文件
    try {
      fs.writeFileSync(path.join(upgitDir, 'config.toml'), configContent, 'utf8');
      logger.writeLog('INFO', `upgit配置文件已生成: ${upgitConfigPath}`);
      
      // 检查文件是否成功写入
      if (fs.existsSync(upgitConfigPath)) {
        const stats = fs.statSync(upgitConfigPath);
        logger.writeLog('INFO', `配置文件大小: ${stats.size} 字节`);
      } else {
        logger.writeLog('ERROR', `写入后配置文件不存在: ${upgitConfigPath}`);
      }
      
      return true;
    } catch (writeErr) {
      logger.writeLog('ERROR', `写入upgit配置文件失败: ${writeErr.message}`, writeErr);
      
      // 尝试写入临时目录
      const tempConfigPath = path.join(app.getPath('temp'), 'MinioPG-upgit', 'config.toml');
      logger.writeLog('WARN', `尝试写入临时配置文件: ${tempConfigPath}`);
      
      try {
        // 确保临时目录存在
        const tempDir = path.dirname(tempConfigPath);
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }
        
        fs.writeFileSync(tempConfigPath, configContent, 'utf8');
        logger.writeLog('INFO', `临时配置文件已生成: ${tempConfigPath}`);
        return true;
      } catch (tempWriteErr) {
        logger.writeLog('ERROR', `写入临时配置文件也失败: ${tempWriteErr.message}`, tempWriteErr);
        return false;
      }
    }
  } catch (error) {
    logger.writeLog('ERROR', `生成upgit配置文件失败: ${error.message}`, error);
    return false;
  }
}

// 加载配置
async function loadConfig() {
  try {
    const configPath = path.join(app.getPath('userData'), 'MinioPG-config.json');
    console.log('配置文件路径:', configPath);
    
    // 测试配置目录写入权限
    try {
      fs.accessSync(path.dirname(configPath), fs.constants.W_OK);
      console.log('配置目录写入权限测试成功');
    } catch (err) {
      console.error('配置目录写入权限测试失败:', err);
    }
    
    if (fs.existsSync(configPath)) {
      const configData = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(configData);
      console.log('读取配置:', config);
      
      // 同步更新upgit配置
      await generateUpgitConfig(config);
      
      return config;
    }
    return null;
  } catch (error) {
    console.error('加载配置失败:', error);
    return null;
  }
}

// 保存配置
async function saveConfig(config) {
  try {
    const configPath = path.join(app.getPath('userData'), 'MinioPG-config.json');
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
    
    // 同步更新upgit配置
    await generateUpgitConfig(config);
    
    return true;
  } catch (error) {
    console.error('保存配置失败:', error);
    return false;
  }
} 
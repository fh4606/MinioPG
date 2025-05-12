const { ipcRenderer } = require('electron');
const { ElMessage, ElLoading, ElMessageBox } = ElementPlus;
const Minio = require('minio');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

// 日志功能
const LOG_FILE = path.join(__dirname, 'logs', 'app.log');

// 确保日志目录存在
if (!fs.existsSync(path.join(__dirname, 'logs'))) {
    fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
}

// 日志函数
function writeLog(message, type = 'INFO') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${type}] ${message}\n`;
    fs.appendFileSync(LOG_FILE, logMessage);
    console.log(`${type}: ${message}`);
}

const app = Vue.createApp({
    data() {
        return {
            activeMenu: 'upload',
            uploadTitle: '文件上传 - MinIO',
            linkFormatList: ['Markdown', 'Html', 'URL', 'UBB', 'Custom'],
            linkFormat: 'Markdown',
            currentUploader: 'MinIO',
            customFormat: '![$fileName]($url)',
            uploadHistory: [],
            minioClient: null,
            fileList: [],
            filteredFileList: [], // 筛选后的文件列表
            loading: false,
            bucketList: [],
            currentBucket: '',
            gridType: 'auto',
            currentPath: '',
            currentUploadPath: '',
            availableDirectories: [],
            // 目录选择对话框控制
            showDirectorySelector: false,
            tempSelectedDirectory: '',
            // 文件类型筛选选项
            showFolders: true,
            showImages: true,
            showOthers: false,
            config: {
                type: 'minio',
                minio: {
                    endpoint: '',
                    port: 9000,
                    useSSL: false,
                    accessKey: '',
                    secretKey: '',
                    bucket: ''
                }
            },
            minioConfig: {
                endPoint: '',
                port: '9000',
                accessKey: '',
                secretKey: '',
                domain: '',
                bucket: ''
            },
            uploadedUrls: [],
            uploadStatus: '',
            selectedFiles: [], // 新增：已选择的文件列表
        }
    },
    methods: {
        handleMenuSelect(key) {
            // 先保存之前的菜单状态
            const previousMenu = this.activeMenu;
            
            // 更新活跃菜单，保证UI立即响应
            this.activeMenu = key;
            
            // 如果切换到文件列表页面，预先设置空数组避免闪烁
            if (key === 'album') {
                if (previousMenu !== 'album') {
                    // 预先设置一个空数组，让列表容器先渲染出来
                    this.filteredFileList = [];
                }
                
                // 只有在MinIO客户端可用时才加载
                if (this.minioClient) {
                    // 延长延迟时间，让界面切换更加流畅
                    setTimeout(() => {
                        this.loadFileList();
                    }, 300);
                }
            }
        },
        async selectFiles() {
            const files = await ipcRenderer.invoke('select-files');
            if (files && files.length > 0) {
                this.uploadFiles(files);
            }
        },
        async handleDrop(e) {
            const files = Array.from(e.dataTransfer.files)
                .filter(file => file.type.startsWith('image/'))
                .map(file => file.path);
            if (files.length > 0) {
                this.uploadFiles(files);
            }
        },
        async uploadFiles(filePaths) {
            if (!this.minioClient || !this.minioConfig.bucket) {
                writeLog('未配置MinIO服务，无法上传文件', 'ERROR');
                ElMessage.error('请先配置并连接MinIO服务');
                this.activeMenu = 'setting';
                return;
            }

            const loading = ElLoading.service({
                lock: true,
                text: '上传中...',
                background: 'rgba(0, 0, 0, 0.7)'
            });

            this.uploadedUrls = [];
            this.uploadStatus = '正在上传...';
            
            try {
                // 记录上传目录
                const targetDir = this.currentUploadPath || '';
                writeLog(`开始上传文件到目录: "${targetDir}"`);
                
                let formattedUrls = [];
                
                for (const filePath of filePaths) {
                    const fileName = path.basename(filePath);
                    writeLog(`正在上传文件: ${fileName}`);
                    
                    // 生成一个唯一的文件名以避免覆盖
                    const uniqueFileName = `${Date.now()}-${fileName}`;
                    
                    // 构建完整的对象路径，包含用户选择的目录
                    const objectName = targetDir 
                        ? `${targetDir}${targetDir.endsWith('/') ? '' : '/'}${uniqueFileName}`
                        : uniqueFileName;
                    
                    // 使用stream上传文件
                    const fileStream = fs.createReadStream(filePath);
                    const fileStats = fs.statSync(filePath);
                    
                    await this.minioClient.putObject(
                        this.minioConfig.bucket,
                        objectName,
                        fileStream,
                        fileStats.size
                    );
                    
                    // 生成URL
                    let fileUrl;
                    if (this.minioConfig.domain) {
                        fileUrl = `${this.minioConfig.domain}/${objectName}`;
                    } else {
                        const protocol = this.minioConfig.useSSL ? 'https' : 'http';
                        fileUrl = `${protocol}://${this.minioConfig.endPoint}:${this.minioConfig.port}/${this.minioConfig.bucket}/${objectName}`;
                    }
                    
                    // 根据选择的格式生成链接
                    let formattedUrl = fileUrl;
                    switch (this.linkFormat) {
                        case 'Markdown':
                            formattedUrl = `![${fileName}](${fileUrl})`;
                            break;
                        case 'Html':
                            formattedUrl = `<img src="${fileUrl}" alt="${fileName}" />`;
                            break;
                        case 'UBB':
                            formattedUrl = `[img]${fileUrl}[/img]`;
                            break;
                        case 'Custom':
                            formattedUrl = this.customFormat
                                .replace('$fileName', fileName)
                                .replace('$url', fileUrl);
                            break;
                    }
                    
                    formattedUrls.push(formattedUrl);
                    
                    // 添加到上传历史
                    this.uploadHistory.unshift({
                        name: fileName,
                        url: fileUrl,
                        formattedUrl: formattedUrl,
                        directory: targetDir || '/',
                        date: new Date().toLocaleString()
                    });
                    
                    writeLog(`文件 ${fileName} 上传成功`);
                }
                
                // 将所有链接合并成一个字符串，每个链接占一行
                const allFormattedUrls = formattedUrls.join('\n');
                
                // 复制所有链接到剪贴板
                const clipboardSuccess = await this.autoClipboard(allFormattedUrls);
                    if (clipboardSuccess) {
                    ElMessage.success(`已上传${filePaths.length}个文件并复制所有链接到剪贴板`);
                    } else {
                        ElMessage.success(`已上传${filePaths.length}个文件，但复制链接失败`);
                }
                
                this.uploadStatus = '上传成功';
                
                // 刷新文件列表
                if (this.activeMenu === 'album') {
                    if (this.currentPath === this.currentUploadPath) {
                        this.loadFileListInFolder();
                    }
                }
            } catch (error) {
                writeLog(`文件上传失败: ${error.message}`, 'ERROR');
                this.uploadStatus = '上传失败';
                ElMessage.error(`上传失败: ${error.message}`);
            } finally {
                loading.close();
            }
        },
        uploadClipboard() {
            const loading = ElLoading.service({
                lock: true,
                text: '处理剪贴板图片中...',
                background: 'rgba(0, 0, 0, 0.7)'
            });
            
            console.log('尝试从剪贴板上传图片...');
            
            ipcRenderer.invoke('upload-clipboard').then(imagePath => {
                loading.close();
                if (imagePath) {
                    console.log('成功从剪贴板获取图片:', imagePath);
                    this.uploadFiles([imagePath]);
                } else {
                    ElMessage.warning('剪贴板中没有图片或图片获取失败');
                }
            }).catch(err => {
                loading.close();
                console.error('剪贴板上传失败:', err);
                ElMessage.error(`剪贴板上传失败: ${err.message}`);
            });
        },
        uploadByUrl() {
            ElMessageBox.prompt('请输入图片URL或Base64数据', '从URL上传', {
                confirmButtonText: '上传',
                cancelButtonText: '取消',
                inputPattern: /^(http|https):\/\/[^ "]+$|^data:image\/(jpeg|png|gif|webp|bmp);base64,/,
                inputErrorMessage: '请输入有效的URL或Base64图片数据',
                inputPlaceholder: '例如: https://example.com/image.jpg 或 data:image/png;base64,...'
            }).then(({ value }) => {
                if (!value) {
                    ElMessage.warning('请输入有效的URL或Base64数据');
                    return;
                }
                
                const loading = ElLoading.service({
                    lock: true,
                    text: '正在处理图片...',
                    background: 'rgba(0, 0, 0, 0.7)'
                });
                
                // 处理Base64图片
                if (value.startsWith('data:image/')) {
                    try {
                        // 从Base64数据中提取图片格式
                        const matches = value.match(/^data:image\/([a-zA-Z]+);base64,/);
                        if (!matches) {
                            loading.close();
                            ElMessage.error('无效的Base64图片格式');
                            return;
                        }
                        
                        const imageFormat = matches[1];
                        const base64Data = value.replace(/^data:image\/[a-zA-Z]+;base64,/, '');
                        
                        // 创建临时文件
                        const tempDir = path.join(os.tmpdir(), 'minio-picgo');
                        if (!fs.existsSync(tempDir)) {
                            fs.mkdirSync(tempDir, { recursive: true });
                        }
                        
                        const timestamp = Date.now();
                        const tempFilePath = path.join(tempDir, `base64-${timestamp}.${imageFormat}`);
                        
                        // 将Base64数据写入文件
                        fs.writeFileSync(tempFilePath, Buffer.from(base64Data, 'base64'));
                        
                        loading.close();
                        console.log('Base64图片已保存到临时文件:', tempFilePath);
                        this.uploadFiles([tempFilePath]);
                    } catch (error) {
                        loading.close();
                        console.error('Base64图片处理失败:', error);
                        ElMessage.error(`Base64图片处理失败: ${error.message}`);
                    }
                } else {
                    // 处理URL图片
                    console.log('尝试从URL下载图片:', value);
                    ipcRenderer.invoke('uploadByUrl', value).then(filePath => {
                    loading.close();
                    if (filePath) {
                        console.log('成功从URL下载图片:', filePath);
                        this.uploadFiles([filePath]);
                    } else {
                        ElMessage.warning('无法从URL获取图片');
                    }
                }).catch(err => {
                    loading.close();
                    console.error('URL下载失败:', err);
                    ElMessage.error(`URL下载失败: ${err.message}`);
                });
                }
            }).catch(() => {
                // 用户取消输入，不做任何操作
            });
        },
        async saveConfig() {
            try {
                // 深拷贝config对象以移除不可序列化的属性
                const configToSave = JSON.parse(JSON.stringify(this.config));
                console.log('正在保存配置...', JSON.stringify(configToSave));
                await ipcRenderer.invoke('save-config', configToSave);
                ElMessage.success('配置保存成功');
                return true;
            } catch (error) {
                console.error('配置保存失败:', error);
                ElMessage.error(`配置保存失败: ${error.message || '未知错误'}`);
                return false;
            }
        },
        async loadConfig() {
            try {
                const config = await ipcRenderer.invoke('get-config');
                if (config) {
                    writeLog('加载配置文件成功');
                    this.config = config;
                    // 同步minioConfig和config
                    if (config.minio) {
                        this.minioConfig.endPoint = config.minio.endpoint || '';
                        this.minioConfig.port = config.minio.port || '9000';
                        this.minioConfig.accessKey = config.minio.accessKey || '';
                        this.minioConfig.secretKey = config.minio.secretKey || '';
                        this.minioConfig.bucket = config.minio.bucket || '';
                    }
                    // 尝试初始化MinIO客户端
                    this.initMinioClient();
                }
            } catch (error) {
                writeLog(`配置加载失败: ${error.message}`, 'ERROR');
                ElMessage.error('配置加载失败');
            }
        },
        copyUrl(url) {
            this.autoClipboard(url).then(success => {
                if (success) {
                    ElMessage.success('链接已复制到剪贴板');
                } else {
                    ElMessage.error('复制失败');
                }
            });
        },
        clearHistory() {
            this.uploadHistory = [];
        },
        async resetConfig() {
            try {
                await ipcRenderer.invoke('clear-config');
                ElMessage.success('配置已重置');
                // 重置内存中的配置
                this.config = {
                    type: 'minio',
                    minio: {
                        endpoint: '',
                        port: 9000,
                        useSSL: false,
                        accessKey: '',
                        secretKey: '',
                        bucket: ''
                    }
                };
                this.minioConfig = {
                    endPoint: '',
                    port: '9000',
                    accessKey: '',
                    secretKey: '',
                    domain: '',
                    bucket: ''
                };
                this.minioClient = null;
                return true;
            } catch (error) {
                console.error('重置配置失败:', error);
                ElMessage.error(`重置配置失败: ${error.message || '未知错误'}`);
                return false;
            }
        },
        saveMinioConfig() {
            // 验证表单
            if (!this.minioConfig.endPoint) {
                ElMessage.error('请输入服务器地址');
                return;
            }
            if (!this.minioConfig.accessKey || !this.minioConfig.secretKey) {
                ElMessage.error('请输入访问密钥');
                return;
            }
            if (!this.minioConfig.bucket) {
                ElMessage.error('请输入存储桶名称');
                return;
            }

            try {
                // 同步到config对象，确保所有属性都是纯数据
                this.config.minio = {
                    endpoint: String(this.minioConfig.endPoint),
                    port: parseInt(this.minioConfig.port) || 9000,
                    accessKey: String(this.minioConfig.accessKey),
                    secretKey: String(this.minioConfig.secretKey),
                    bucket: String(this.minioConfig.bucket),
                    domain: String(this.minioConfig.domain || ''),
                    useSSL: Boolean(this.minioConfig.endPoint.startsWith('https'))
                };
                
                // 保存配置
                this.saveConfig().then(success => {
                    if (success) {
                        // 初始化MinIO客户端
                        this.initMinioClient();
                    }
                });
            } catch (error) {
                console.error('保存MinIO配置失败:', error);
                ElMessage.error(`保存MinIO配置失败: ${error.message || '未知错误'}`);
            }
        },
        initMinioClient() {
            try {
                const { endPoint, port, accessKey, secretKey } = this.minioConfig;
                
                // 验证连接参数
                if (!endPoint || !accessKey || !secretKey) {
                    console.error('缺少必要的连接参数');
                    ElMessage.error('缺少必要的连接参数');
                    return;
                }
                
                // 移除协议前缀
                let minioEndpoint = endPoint.replace(/^https?:\/\//, '');
                
                // 确定是否使用SSL
                const useSSL = endPoint.startsWith('https');
                
                // 端口转为数字
                const portNumber = parseInt(port) || 9000;
                
                console.log('MinIO连接参数:', {
                    endPoint: minioEndpoint,
                    port: portNumber,
                    useSSL,
                    accessKey: accessKey.substring(0, 3) + '***',
                    secretKey: '******'
                });
                
                // 创建MinIO客户端
                this.minioClient = new Minio.Client({
                    endPoint: minioEndpoint,
                    port: portNumber,
                    useSSL: useSSL,
                    accessKey: accessKey,
                    secretKey: secretKey
                });
                
                // 测试连接
                this.testConnection();
            } catch (error) {
                console.error('初始化MinIO客户端失败:', error);
                ElMessage.error(`初始化MinIO客户端失败: ${error.message}`);
                this.minioClient = null;
            }
        },
        async testConnection() {
            if (!this.minioClient) return;
            
            const loading = ElLoading.service({
                lock: true,
                text: '测试连接中...',
                background: 'rgba(0, 0, 0, 0.7)'
            });
            
            try {
                writeLog('开始测试MinIO连接');
                // 获取配置路径信息（用于调试）
                const configPathInfo = await ipcRenderer.invoke('get-config-path');
                writeLog(`配置文件路径: ${JSON.stringify(configPathInfo)}`);
                
                // 列出所有存储桶
                writeLog('正在连接MinIO服务器...');
                this.bucketList = await this.minioClient.listBuckets();
                writeLog(`获取到存储桶列表: ${this.bucketList.map(b => b.name).join(', ')}`);
                
                // 确保存储桶存在
                writeLog(`检查存储桶是否存在: ${this.minioConfig.bucket}`);
                const bucketExists = await this.minioClient.bucketExists(this.minioConfig.bucket);
                if (!bucketExists) {
                    writeLog(`存储桶不存在，创建新存储桶: ${this.minioConfig.bucket}`);
                    await this.minioClient.makeBucket(this.minioConfig.bucket);
                    ElMessage.success(`存储桶 ${this.minioConfig.bucket} 创建成功`);
                    writeLog(`存储桶 ${this.minioConfig.bucket} 创建成功`);
                } else {
                    writeLog(`存储桶已存在: ${this.minioConfig.bucket}`);
                }
                
                ElMessage.success('MinIO连接成功！');
                writeLog('MinIO连接测试成功');
                
                // 如果当前在文件列表页面，加载文件列表
                if (this.activeMenu === 'album') {
                    this.loadFileList();
                }
            } catch (error) {
                writeLog(`MinIO连接测试失败: ${error.message}`, 'ERROR');
                
                // 提供更具体的错误信息
                let errorMsg = `MinIO连接测试失败: ${error.message}`;
                if (error.code === 'ECONNREFUSED') {
                    errorMsg = `无法连接到服务器，请检查地址和端口是否正确: ${error.message}`;
                } else if (error.code === 'InvalidAccessKeyId') {
                    errorMsg = '无效的访问密钥ID，请检查accessKey';
                } else if (error.code === 'SignatureDoesNotMatch') {
                    errorMsg = '签名不匹配，请检查secretKey是否正确';
                } else if (error.code === 'NoSuchBucket') {
                    errorMsg = `存储桶 ${this.minioConfig.bucket} 不存在`;
                }
                
                ElMessage.error(errorMsg);
            } finally {
                loading.close();
            }
        },
        async loadFileList() {
            // 清空已选择的文件
            this.selectedFiles = [];
            
            // 重置当前路径
            this.currentPath = '';
            this.loadFileListInFolder();
        },
        formatFileSize(bytes) {
            if (bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        },
        async deleteFile(file) {
            if (!this.minioClient || !this.minioConfig.bucket) return;
            
            // 弹出确认对话框
            ElMessageBox.confirm(
                `确定要删除${file.isFolder ? '文件夹' : '文件'} "${file.name}" 吗？`,
                '删除确认',
                {
                    confirmButtonText: '确定',
                    cancelButtonText: '取消',
                    type: 'warning'
                }
            ).then(async () => {
                const loading = ElLoading.service({
                    lock: true,
                    text: `删除${file.isFolder ? '文件夹' : '文件'}中...`,
                    background: 'rgba(0, 0, 0, 0.7)'
                });
                
                try {
                    if (file.isFolder) {
                        // 删除文件夹需要先列出文件夹中的所有对象，然后逐个删除
                        const prefix = file.fullPath || file.name;
                        const objectsList = [];
                        
                        // 获取文件夹中的所有对象
                        const stream = this.minioClient.listObjects(this.minioConfig.bucket, prefix, true);
                        
                        stream.on('data', (obj) => {
                            objectsList.push(obj.name);
                        });
                        
                        // 等待所有对象列出完成
                        await new Promise((resolve, reject) => {
                            stream.on('end', resolve);
                            stream.on('error', reject);
                        });
                        
                        // 如果是空文件夹，也要删除文件夹对象本身
                        if (!objectsList.includes(prefix)) {
                            objectsList.push(prefix);
                        }
                        
                        // 删除所有对象
                        if (objectsList.length > 0) {
                            await this.minioClient.removeObjects(
                                this.minioConfig.bucket,
                                objectsList
                            );
                        }
                        
                        ElMessage.success(`文件夹 ${file.name} 已删除`);
                    } else {
                        // 删除单个文件
                        const objectName = file.fullPath || file.name;
                        await this.minioClient.removeObject(this.minioConfig.bucket, objectName);
                        ElMessage.success(`文件 ${file.name} 已删除`);
                    }
                    
                    // 刷新文件列表
                    this.loadFileListInFolder();
                    
                    // 从历史记录中移除
                    if (!file.isFolder) {
                        this.uploadHistory = this.uploadHistory.filter(h => !h.url.includes(file.name));
                    }
                } catch (error) {
                    console.error('删除失败:', error);
                    ElMessage.error(`删除失败: ${error.message}`);
                } finally {
                    loading.close();
                }
            }).catch(() => {
                // 用户取消，不做任何操作
            });
        },
        // 预览图片
        previewImage(image) {
            ElMessageBox.alert(
                `<div class="image-preview-container">
                    <img src="${image.url}" alt="${image.name}" class="preview-image">
                </div>`,
                image.name,
                {
                    dangerouslyUseHTMLString: true,
                    showCancelButton: false,
                    confirmButtonText: '关闭',
                    customClass: {
                        container: 'image-preview-dialog',
                        content: 'image-preview-content',
                        header: 'image-preview-header',
                        confirmButton: 'image-preview-confirm-button'
                    },
                    beforeClose: (action, instance, done) => {
                        done();
                    }
                }
            );
        },
        // 重命名文件
        renameFile(file) {
            const originalName = file.name;
            let nameWithoutExt, extension;
            
            // 处理文件夹和文件的不同情况
            if (file.isFolder) {
                // 文件夹名，去掉末尾的斜杠
                nameWithoutExt = originalName.endsWith('/') 
                    ? originalName.substring(0, originalName.length - 1) 
                    : originalName;
                extension = '/';
            } else {
                // 文件名，分离扩展名
                const dotIndex = originalName.lastIndexOf('.');
                nameWithoutExt = dotIndex !== -1 ? originalName.substring(0, dotIndex) : originalName;
                extension = dotIndex !== -1 ? originalName.substring(dotIndex) : '';
            }
            
            ElMessageBox.prompt('输入新名称', '重命名' + (file.isFolder ? '文件夹' : '文件'), {
                confirmButtonText: '确定',
                cancelButtonText: '取消',
                inputValue: nameWithoutExt,
                inputPattern: /^[^\\/:\*\?"<>\|]+$/,  // 名称不能包含这些特殊字符
                inputErrorMessage: '名称不能包含特殊字符'
            }).then(({ value }) => {
                if (!value) {
                    ElMessage.warning('名称不能为空');
                    return;
                }
                
                const newName = `${value}${extension}`;
                this.handleRenameFile(file, newName);
            }).catch(() => {
                // 用户取消，不做任何操作
            });
        },
        // 创建文件夹
        createFolder() {
            // 弹出对话框让用户输入文件夹名称
            ElMessageBox.prompt('请输入文件夹名称', '创建文件夹', {
                confirmButtonText: '确定',
                cancelButtonText: '取消',
                inputPattern: /^[^\\/:\*\?"<>\|]+$/,  // 文件夹名不能包含这些特殊字符
                inputErrorMessage: '文件夹名不能包含特殊字符'
            }).then(({ value }) => {
                if (!value) {
                    ElMessage.warning('文件夹名不能为空');
                    return;
                }
                
                // 添加斜杠后缀表示这是一个文件夹
                const folderName = value.endsWith('/') ? value : `${value}/`;
                this.createMinioFolder(folderName);
            }).catch(() => {
                // 用户取消，不做操作
            });
        },
        
        // 在MinIO中创建文件夹
        async createMinioFolder(folderName) {
            if (!this.minioClient || !this.minioConfig.bucket) {
                ElMessage.error('请先配置并连接MinIO服务');
                this.activeMenu = 'setting';
                return;
            }
            
            const loading = ElLoading.service({
                lock: true,
                text: '创建文件夹中...',
                background: 'rgba(0, 0, 0, 0.7)'
            });
            
            try {
                // 确保folderName以斜杠结尾但不以斜杠开头
                let cleanFolderName = folderName;
                if (cleanFolderName.startsWith('/')) {
                    cleanFolderName = cleanFolderName.substring(1);
                }
                if (!cleanFolderName.endsWith('/')) {
                    cleanFolderName = cleanFolderName + '/';
                }
                
                // 构建完整的文件夹路径
                const folderPath = this.currentPath + cleanFolderName;
                
                console.log('创建文件夹:', folderPath);
                
                // MinIO实际上没有文件夹的概念，创建一个空对象作为文件夹标记
                await this.minioClient.putObject(
                    this.minioConfig.bucket,
                    folderPath,
                    Buffer.from('')  // 空内容
                );
                
                console.log('文件夹创建成功');
                
                // 在成功创建后，将新文件夹添加到文件列表中
                if (!this.fileList.some(item => item.name === cleanFolderName && item.isFolder)) {
                    this.fileList.push({
                        name: cleanFolderName,
                        fullPath: folderPath,
                        isFolder: true,
                        size: '-',
                        lastModified: new Date().toLocaleString(),
                        url: '#'
                    });
                    
                    // 重新排序文件夹在前，文件在后
                    this.fileList.sort((a, b) => {
                        if (a.isParent) return -1;
                        if (b.isParent) return 1;
                        if (a.isFolder && !b.isFolder) return -1;
                        if (!a.isFolder && b.isFolder) return 1;
                        return a.name.localeCompare(b.name);
                    });
                    
                    // 应用筛选条件
                    this.applyFilters();
                }
                
                // 如果是新创建的一级文件夹，同时添加到可用目录列表中
                if (!this.currentPath && !this.availableDirectories.some(dir => dir.name === cleanFolderName)) {
                    this.availableDirectories.push({
                        name: cleanFolderName,
                        fullPath: folderPath,
                        isFolder: true,
                        lastModified: new Date().toLocaleString()
                    });
                    
                    // 对目录列表排序
                    this.availableDirectories.sort((a, b) => a.name.localeCompare(b.name));
                }
                
                ElMessage.success(`文件夹 ${cleanFolderName.replace('/', '')} 创建成功`);
                
                // 延迟一下再刷新文件列表，确保MinIO服务端有时间处理
                setTimeout(() => {
                    this.loadFileListInFolder();
                }, 500);
            } catch (error) {
                console.error('创建文件夹失败:', error);
                ElMessage.error(`创建文件夹失败: ${error.message}`);
            } finally {
                loading.close();
            }
        },
        
        // 关闭消息框
        closeMessageBox() {
            const closeBtn = document.querySelector('.el-message-box__headerbtn');
            if (closeBtn) {
                closeBtn.click();
            }
        },
        // 处理文件重命名
        async handleRenameFile(file, newName) {
            if (!this.minioClient || !this.minioConfig.bucket) return;
            
            const loading = ElLoading.service({
                lock: true,
                text: '重命名中...',
                background: 'rgba(0, 0, 0, 0.7)'
            });
            
            try {
                const oldPath = file.fullPath || file.name;
                // 构建新路径
                let newPath;
                
                // 处理父目录路径
                if (file.isFolder) {
                    // 对于文件夹，计算父目录路径
                    const pathParts = oldPath.split('/').filter(p => p);
                    pathParts.pop(); // 移除最后一个部分（当前文件夹名）
                    const parentPath = pathParts.length > 0 ? `${pathParts.join('/')}/` : '';
                    newPath = `${parentPath}${newName}`;
                } else {
                    // 对于文件，保持在同一目录
                    const lastSlashIndex = oldPath.lastIndexOf('/');
                    const parentPath = lastSlashIndex !== -1 ? oldPath.substring(0, lastSlashIndex + 1) : '';
                    newPath = `${parentPath}${newName}`;
                }
                
                if (file.isFolder) {
                    // 重命名文件夹需要复制文件夹中的所有对象到新路径，然后删除旧的
                    const objectsList = [];
                    const copyTasks = [];
                    
                    // 获取文件夹中的所有对象
                    const stream = this.minioClient.listObjects(this.minioConfig.bucket, oldPath, true);
                    
                    stream.on('data', (obj) => {
                        objectsList.push(obj.name);
                        
                        // 计算对象在新路径下的名称
                        const relativePath = obj.name.substring(oldPath.length);
                        const newObjectPath = `${newPath}${relativePath}`;
                        
                        // 创建复制任务
                        const copyTask = this.minioClient.copyObject(
                            this.minioConfig.bucket,
                            newObjectPath,
                            `${this.minioConfig.bucket}/${obj.name}`
                        );
                        
                        copyTasks.push(copyTask);
                    });
                    
                    // 等待所有对象列出完成
                    await new Promise((resolve, reject) => {
                        stream.on('end', resolve);
                        stream.on('error', reject);
                    });
                    
                    // 如果是空文件夹，也要复制文件夹对象本身
                    if (objectsList.length === 0) {
                        await this.minioClient.putObject(
                            this.minioConfig.bucket,
                            newPath,
                            Buffer.from('')
                        );
                    } else {
                        // 等待所有复制任务完成
                        await Promise.all(copyTasks);
                        
                        // 删除所有旧对象
                        await this.minioClient.removeObjects(
                            this.minioConfig.bucket,
                            objectsList
                        );
                    }
                } else {
                    // MinIO没有直接的重命名功能，需要复制然后删除
                    // 1. 读取原文件
                    const dataStream = await this.minioClient.getObject(
                        this.minioConfig.bucket,
                        oldPath
                    );
                    
                    // 收集数据到缓冲区
                    const chunks = [];
                    for await (const chunk of dataStream) {
                        chunks.push(chunk);
                    }
                    const fileBuffer = Buffer.concat(chunks);
                    
                    // 2. 上传到新名称
                    await this.minioClient.putObject(
                        this.minioConfig.bucket,
                        newPath,
                        fileBuffer
                    );
                    
                    // 3. 删除原文件
                    await this.minioClient.removeObject(
                        this.minioConfig.bucket,
                        oldPath
                    );
                }
                
                // 刷新文件列表
                this.loadFileListInFolder();
                
                // 更新上传历史（只处理文件）
                if (!file.isFolder) {
                    // 生成新URL
                    let newUrl;
                    if (this.minioConfig.domain) {
                        newUrl = `${this.minioConfig.domain}/${newPath}`;
                    } else {
                        const protocol = this.minioConfig.useSSL ? 'https' : 'http';
                        newUrl = `${protocol}://${this.minioConfig.endPoint}:${this.minioConfig.port}/${this.minioConfig.bucket}/${newPath}`;
                    }
                    
                    const historyIndex = this.uploadHistory.findIndex(h => h.url === file.url);
                    if (historyIndex !== -1) {
                        const updatedHistory = {
                            ...this.uploadHistory[historyIndex],
                            name: newName,
                            url: newUrl
                        };
                        this.uploadHistory.splice(historyIndex, 1, updatedHistory);
                    }
                }
                
                ElMessage.success(`${file.isFolder ? '文件夹' : '文件'}已重命名为 ${newName}`);
            } catch (error) {
                console.error('重命名失败:', error);
                ElMessage.error(`重命名失败: ${error.message}`);
            } finally {
                loading.close();
            }
        },
        // 打开文件夹
        openFolder(folder) {
            // 无需检查全局loading状态
            try {
                console.log('打开文件夹:', folder);
                
                // 处理返回上级目录的情况
                if (folder.isParent) {
                    console.log('返回上级目录:', folder.originalPath);
                    this.currentPath = folder.originalPath;
                } else {
                    // 更新当前路径
                    console.log('进入文件夹:', folder.fullPath || folder.name);
                    this.currentPath = folder.fullPath || folder.name;
                }
                
                // 延迟一下再加载，避免界面卡顿
                setTimeout(() => {
                    // 重新加载文件列表
                    this.loadFileListInFolder();
                }, 100);
            } catch (error) {
                console.error('打开文件夹失败:', error);
                ElMessage.error(`打开文件夹失败: ${error.message}`);
            }
        },
        
        // 加载特定文件夹中的文件
        async loadFileListInFolder() {
            if (!this.minioClient || !this.minioConfig.bucket) return;
            
            // 清空已选择的文件
            this.selectedFiles = [];
            
            // 收集所有数据后一次性更新，减少DOM更新次数
            let tempFileList = [];
            
            // 设置一个延迟计时器，只有加载时间超过200ms才显示加载指示器
            let loadingInstance = null;
            const loadingTimer = setTimeout(() => {
                loadingInstance = ElLoading.service({
                    target: '.gallery-container',
                    lock: true,
                    text: '加载中...',
                    background: 'rgba(0, 0, 0, 0.3)' // 降低背景透明度，减轻视觉冲击
                });
            }, 200);
            
            try {
                // 如果不是根目录，添加返回上级目录的选项
                if (this.currentPath) {
                    // 计算上级目录路径
                    const pathParts = this.currentPath.split('/').filter(p => p);
                    
                    // 如果有上级目录
                    if (pathParts.length > 0) {
                        // 删除最后一个部分，获取父目录
                        pathParts.pop();
                        const parentPath = pathParts.length > 0 ? `${pathParts.join('/')}/` : '';
                        
                        // 添加返回上级目录的项
                        tempFileList.push({
                            name: '../',
                            isFolder: true,
                            isParent: true,
                            originalPath: parentPath,
                            size: '-',
                            lastModified: '-',
                            url: '#'
                        });
                    }
                }
                
                // 列出对象并收集所有文件和文件夹
                const prefix = this.currentPath;
                let objectList = [];
                let foundFolders = new Set();
                
                // 收集所有对象
                const objectsStream = this.minioClient.listObjects(
                    this.minioConfig.bucket,
                    prefix,
                    true // 递归模式
                );
                
                // 处理所有对象
                await new Promise((resolve, reject) => {
                    objectsStream.on('data', (obj) => {
                        // 将对象添加到列表
                        objectList.push(obj);
                        
                        // 检查对象路径中的文件夹
                        if (obj.name !== prefix) {
                            const relativePath = obj.name.substring(prefix.length);
                            const pathParts = relativePath.split('/');
                            
                            // 只处理第一级文件夹
                            if (pathParts.length > 1) {
                                const folderName = pathParts[0] + '/';
                                foundFolders.add(folderName);
                            }
                        }
                    });
                    
                    objectsStream.on('end', resolve);
                    objectsStream.on('error', reject);
                });
                
                // 添加文件夹到列表
                for (const folderName of foundFolders) {
                    if (!tempFileList.some(item => item.name === folderName && item.isFolder)) {
                        tempFileList.push({
                            name: folderName,
                            fullPath: prefix + folderName,
                            isFolder: true,
                            size: '-',
                            lastModified: '-',
                            url: '#'
                        });
                    }
                }
                
                // 处理当前路径下的直接文件
                for (const obj of objectList) {
                    // 跳过当前文件夹自身
                    if (obj.name === prefix) continue;
                    
                    const relativePath = obj.name.substring(prefix.length);
                    
                    // 只处理当前文件夹下的直接文件（不包含子文件夹中的文件）
                    if (!relativePath.includes('/')) {
                        // 检查是否是图片或其他文件
                        const isImage = this.isImageFile(obj.name);
                        
                        // 生成URL
                        let fileUrl;
                        if (this.minioConfig.domain) {
                            fileUrl = `${this.minioConfig.domain}/${obj.name}`;
                        } else {
                            const protocol = this.minioConfig.useSSL ? 'https' : 'http';
                            fileUrl = `${protocol}://${this.minioConfig.endPoint}:${this.minioConfig.port}/${this.minioConfig.bucket}/${obj.name}`;
                        }
                        
                        tempFileList.push({
                            name: relativePath,
                            fullPath: obj.name,
                            isFolder: false,
                            isImage: isImage,
                            size: this.formatFileSize(obj.size),
                            lastModified: new Date(obj.lastModified).toLocaleString(),
                            url: fileUrl
                        });
                    }
                }
                
                // 处理空文件夹 - 改进的方法，更可靠地检测文件夹
                try {
                    // 使用多种方法检查文件夹
                    console.log('检查空文件夹和文件夹对象');
                    
                    // 方法1: 使用非递归方式检查直接子文件夹
                    const emptyFolderObjects = await this.minioClient.listObjects(
                        this.minioConfig.bucket,
                        prefix,
                        false
                    ).toArray();
                    
                    for (const obj of emptyFolderObjects) {
                        if (obj.name !== prefix && obj.name.endsWith('/')) {
                            const relativePath = obj.name.substring(prefix.length);
                            // 确保只处理直接子文件夹
                            if (!relativePath.includes('/', 1)) {
                                if (!tempFileList.some(item => item.name === relativePath && item.isFolder)) {
                                    console.log('发现空文件夹:', obj.name);
                                    tempFileList.push({
                                        name: relativePath,
                                        fullPath: obj.name,
                                        isFolder: true,
                                        size: '-',
                                        lastModified: new Date(obj.lastModified).toLocaleString(),
                                        url: '#'
                                    });
                                }
                            }
                        }
                    }
                    
                    // 方法2: 使用V2 API尝试检测文件夹
                    try {
                        const folderObjects = await this.minioClient.listObjectsV2(
                            this.minioConfig.bucket,
                            prefix,
                            false
                        ).toArray();
                        
                        for (const obj of folderObjects) {
                            if (obj.name !== prefix && obj.name.endsWith('/')) {
                                const relativePath = obj.name.substring(prefix.length);
                                // 确保只处理直接子文件夹
                                if (!relativePath.includes('/', 1)) {
                                    if (!tempFileList.some(item => item.name === relativePath && item.isFolder)) {
                                        console.log('通过V2 API发现文件夹:', obj.name);
                                        tempFileList.push({
                                            name: relativePath,
                                            fullPath: obj.name,
                                            isFolder: true,
                                            size: '-',
                                            lastModified: new Date(obj.lastModified).toLocaleString(),
                                            url: '#'
                                        });
                                    }
                                }
                            }
                        }
                    } catch (v2Error) {
                        console.warn('V2 API获取文件夹失败:', v2Error);
                    }
                } catch (err) {
                    console.warn('获取空文件夹时出错:', err);
                    // 继续处理，不中断主流程
                }
                
                // 文件排序：先返回上级，再文件夹，最后文件
                tempFileList.sort((a, b) => {
                    if (a.isParent) return -1;
                    if (b.isParent) return 1;
                    if (a.isFolder && !b.isFolder) return -1;
                    if (!a.isFolder && b.isFolder) return 1;
                    return a.name.localeCompare(b.name);
                });
                
                // 去重（可能会有重复的文件夹）
                tempFileList = tempFileList.filter((item, index, self) => 
                    index === self.findIndex((t) => t.name === item.name)
                );
                
                // 一次性更新fileList
                tempFileList = tempFileList.map(item => ({
                    ...item,
                    selected: false // 确保所有文件的选择状态都被重置
                }));
                this.fileList = tempFileList;
                
                // 批量应用筛选条件
                this.applyFilters();
            } catch (error) {
                console.error('加载文件列表失败:', error);
                ElMessage.error(`加载文件列表失败: ${error.message}`);
            } finally {
                // 清除计时器
                clearTimeout(loadingTimer);
                // 如果加载指示器已创建，则关闭它
                if (loadingInstance) {
                    loadingInstance.close();
                }
            }
        },
        // 选择上传目标目录
        async selectTargetDirectory() {
            // 此方法现在由showDirectorySelector替代，保留作为兼容性
            console.log('使用老方法选择目录，将切换到新方法');
            this.showDirectorySelector = true;
            await this.loadAvailableDirectories();
            this.tempSelectedDirectory = this.currentUploadPath;
        },
        
        // 确认目录选择
        confirmDirectorySelection() {
            console.log(`确认目录选择: ${this.tempSelectedDirectory}`);
            
            // 确保目录路径末尾有斜杠
            let normalizedPath = this.tempSelectedDirectory || '';
            if (normalizedPath && !normalizedPath.endsWith('/')) {
                normalizedPath += '/';
            }
            
            this.currentUploadPath = normalizedPath;
            
            // 更新上传标题以显示当前目录
            const displayPath = this.currentUploadPath || '/';
            ElMessage.success(`已设置上传目录: ${displayPath}`);
            
            // 关闭目录选择对话框
            this.showDirectorySelector = false;
        },
        
        // 加载可用的目录列表（一级目录）
        async loadAvailableDirectories() {
            // 创建一个本地loading状态变量，避免干扰全局loading状态
            const dirLoading = ElLoading.service({
                lock: true,
                text: '加载目录列表...',
                background: 'rgba(0, 0, 0, 0.7)'
            });
            
            try {
                this.availableDirectories = [];
                
                if (!this.minioClient || !this.minioConfig.bucket) {
                    console.error('MinIO客户端未初始化或未设置存储桶');
                    ElMessage.error('请先配置并连接MinIO服务');
                    return [];
                }
                
                console.log('开始加载可用目录，当前桶:', this.minioConfig.bucket);
                
                // 先探测根目录下的文件夹结构
                try {
                    console.log('方法1: 使用listObjectsV2探测所有文件夹');
                    // 这个方法可能能更好地获取目录结构
                    const directoryObjects = await this.minioClient.listObjectsV2(
                        this.minioConfig.bucket, 
                        '', // 从根目录开始
                        true // 递归获取
                    ).toArray();
                    
                    console.log(`找到 ${directoryObjects.length} 个对象`);
                    
                    // 提取一级文件夹
                    for (const obj of directoryObjects) {
                        // 检查是否是文件夹（以/结尾）
                        if (obj.name.endsWith('/')) {
                            // 检查是否是一级文件夹
                            const parts = obj.name.split('/').filter(p => p.length > 0);
                            if (parts.length === 1) {
                                console.log('发现一级目录:', obj.name);
                                if (!this.availableDirectories.some(dir => dir.name === obj.name)) {
                                    this.availableDirectories.push({
                                        name: obj.name,
                                        fullPath: obj.name,
                                        isFolder: true,
                                        lastModified: obj.lastModified ? new Date(obj.lastModified).toLocaleString() : '-'
                                    });
                                }
                            }
                        } 
                        // 从文件路径推断一级文件夹
                        else if (obj.name.includes('/')) {
                            const firstFolder = obj.name.split('/')[0] + '/';
                            if (!this.availableDirectories.some(dir => dir.name === firstFolder)) {
                                console.log('从文件路径推断一级目录:', firstFolder);
                                this.availableDirectories.push({
                                    name: firstFolder,
                                    fullPath: firstFolder,
                                    isFolder: true,
                                    lastModified: '-'
                                });
                            }
                        }
                    }
                } catch (err) {
                    console.warn('方法1获取目录失败:', err);
                }
                
                // 如果上面的方法失败或没找到目录，尝试使用直接列出根目录的方法
                if (this.availableDirectories.length === 0) {
                    console.log('方法2: 直接列出根目录下的对象');
                    try {
                        const rootObjects = await this.minioClient.listObjects(
                            this.minioConfig.bucket,
                            '',  // 根目录
                            true  // 递归
                        ).toArray();
                        
                        console.log(`根目录下找到 ${rootObjects.length} 个对象`);
                        
                        // 从所有对象中提取一级目录
                        for (const obj of rootObjects) {
                            if (obj.name.includes('/')) {
                                const firstDir = obj.name.split('/')[0] + '/';
                                if (!this.availableDirectories.some(dir => dir.name === firstDir)) {
                                    console.log('从对象路径发现目录:', firstDir);
                                    this.availableDirectories.push({
                                        name: firstDir,
                                        fullPath: firstDir,
                                        isFolder: true,
                                        lastModified: '-'
                                    });
                                }
                            }
                        }
                    } catch (err) {
                        console.warn('方法2获取目录失败:', err);
                    }
                }
                
                // 最后尝试基于当前文件列表推断目录
                if (this.availableDirectories.length === 0 && this.fileList.length > 0) {
                    console.log('方法3: 基于现有文件列表推断目录');
                    // 从文件列表中提取文件夹
                    const folders = this.fileList.filter(item => item.isFolder && !item.isParent);
                    for (const folder of folders) {
                        // 只处理一级文件夹
                        if (!folder.name.substring(0, folder.name.length - 1).includes('/')) {
                            console.log('从fileList中找到文件夹:', folder.name);
                            if (!this.availableDirectories.some(dir => dir.name === folder.name)) {
                                this.availableDirectories.push({
                                    name: folder.name,
                                    fullPath: folder.fullPath || folder.name,
                                    isFolder: true,
                                    lastModified: folder.lastModified || '-'
                                });
                            }
                        }
                    }
                }
                
                // 如果仍然没有找到目录，尝试显式加载文件列表
                if (this.availableDirectories.length === 0) {
                    console.log('方法4: 显式加载文件列表寻找目录');
                    // 先保存当前路径
                    const currentPathBackup = this.currentPath;
                    // 临时设为根目录
                    this.currentPath = '';
                    
                    try {
                        // 创建一个临时的列表对象
                        const tempList = [];
                        
                        // 列出根目录下的对象
                        const stream = this.minioClient.listObjects(this.minioConfig.bucket, '', false);
                        
                        // 处理数据流
                        await new Promise((resolve, reject) => {
                            stream.on('data', (obj) => {
                                // 尝试识别文件夹
                                if (obj.name.endsWith('/') && !obj.name.substring(0, obj.name.length - 1).includes('/')) {
                                    console.log('显式加载发现目录:', obj.name);
                                    tempList.push({
                                        name: obj.name,
                                        fullPath: obj.name,
                                        isFolder: true,
                                        lastModified: obj.lastModified ? new Date(obj.lastModified).toLocaleString() : '-'
                                    });
                                }
                            });
                            
                            stream.on('end', resolve);
                            stream.on('error', reject);
                        });
                        
                        // 将找到的文件夹添加到可用目录列表
                        for (const folder of tempList) {
                            if (!this.availableDirectories.some(dir => dir.name === folder.name)) {
                                this.availableDirectories.push(folder);
                            }
                        }
                    } catch (err) {
                        console.warn('方法4获取目录失败:', err);
                    } finally {
                        // 恢复当前路径
                        this.currentPath = currentPathBackup;
                    }
                }
                
                console.log(`完成扫描，找到 ${this.availableDirectories.length} 个可用目录:`, this.availableDirectories.map(d => d.name));
                
                // 对目录列表排序
                this.availableDirectories.sort((a, b) => a.name.localeCompare(b.name));
                
                return this.availableDirectories;
            } catch (error) {
                console.error('加载目录列表失败:', error);
                ElMessage.error(`加载目录列表失败: ${error.message}`);
                return [];
            } finally {
                // 确保在所有情况下都关闭loading
                dirLoading.close();
            }
        },
        // 检查是否为图片文件
        isImageFile(filename) {
            const ext = path.extname(filename).toLowerCase();
            return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext);
        },
        
        // 应用筛选条件到文件列表
        applyFilters() {
            console.log('应用筛选条件:', {
                folders: this.showFolders,
                images: this.showImages,
                others: this.showOthers
            });
            
            // 如果所有筛选条件都禁用，默认显示全部
            if (!this.showFolders && !this.showImages && !this.showOthers) {
                console.log('所有筛选条件都禁用，默认显示全部');
                this.filteredFileList = [...this.fileList];
                return;
            }
            
            // 过滤文件列表
            this.filteredFileList = this.fileList.filter(item => {
                // 返回上级目录项始终显示
                if (item.isParent) {
                    return true;
                }
                
                // 文件夹筛选
                if (item.isFolder) {
                    return this.showFolders;
                }
                
                // 判断是否为图片
                const isImage = this.isImageFile(item.name);
                
                // 图片筛选
                if (isImage) {
                    return this.showImages;
                }
                
                // 其它文件筛选
                return this.showOthers;
            });
            
            console.log(`筛选后显示 ${this.filteredFileList.length} 个项目，总共 ${this.fileList.length} 个`);
        },
        // 添加一个新函数处理自动剪贴板复制
        async autoClipboard(text) {
            try {
                await navigator.clipboard.writeText(text);
                console.log('已自动复制到剪贴板:', text.substring(0, 30) + '...');
                return true;
            } catch (error) {
                console.error('剪贴板复制失败:', error);
                return false;
            }
        },
        // 处理文件选择
        handleItemSelect(item) {
            if (item.selected) {
                this.selectedFiles.push(item);
            } else {
                const index = this.selectedFiles.findIndex(f => f.name === item.name);
                if (index !== -1) {
                    this.selectedFiles.splice(index, 1);
                }
            }
        },
        
        // 批量删除
        async batchDelete() {
            if (this.selectedFiles.length === 0) return;
            
            try {
                await ElMessageBox.confirm(
                    `确定要删除选中的 ${this.selectedFiles.length} 个项目吗？`,
                    '批量删除确认',
                    {
                        confirmButtonText: '确定',
                        cancelButtonText: '取消',
                        type: 'warning'
                    }
                );
                
                const loading = ElLoading.service({
                    lock: true,
                    text: '批量删除中...',
                    background: 'rgba(0, 0, 0, 0.7)'
                });
                
                try {
                    // 创建删除任务队列
                    const deletePromises = this.selectedFiles.map(async (file) => {
                        try {
                            if (file.isFolder) {
                                // 删除文件夹及其内容
                                const prefix = file.fullPath || file.name;
                                const objectsList = [];
                                
                                const stream = this.minioClient.listObjects(this.minioConfig.bucket, prefix, true);
                                
                                await new Promise((resolve, reject) => {
                                    stream.on('data', (obj) => {
                                        objectsList.push(obj.name);
                                    });
                                    stream.on('end', resolve);
                                    stream.on('error', reject);
                                });
                                
                                if (objectsList.length > 0) {
                                    await this.minioClient.removeObjects(
                                        this.minioConfig.bucket,
                                        objectsList
                                    );
                                }
                            } else {
                                // 删除单个文件
                                await this.minioClient.removeObject(
                                    this.minioConfig.bucket,
                                    file.fullPath || file.name
                                );
                            }
                            return { success: true, file };
                        } catch (error) {
                            return { success: false, file, error };
                        }
                    });
                    
                    // 执行所有删除任务
                    const results = await Promise.all(deletePromises);
                    
                    // 统计结果
                    const successCount = results.filter(r => r.success).length;
                    const failCount = results.filter(r => !r.success).length;
                    
                    // 显示结果
                    if (failCount === 0) {
                        ElMessage.success(`成功删除 ${successCount} 个项目`);
                    } else {
                        ElMessage.warning(`成功删除 ${successCount} 个项目，${failCount} 个项目删除失败`);
                    }
                    
                    // 清空选择
                    this.selectedFiles = [];
                    this.fileList.forEach(item => item.selected = false);
                    
                    // 刷新文件列表
                    this.loadFileListInFolder();
                } catch (error) {
                    console.error('批量删除失败:', error);
                    ElMessage.error(`批量删除失败: ${error.message}`);
                } finally {
                    loading.close();
                }
            } catch {
                // 用户取消删除操作
            }
        },
        // 添加悬浮窗切换方法
        async toggleFloatingMode() {
            try {
                await ipcRenderer.invoke('toggle-floating-mode');
                writeLog('切换悬浮窗模式');
            } catch (error) {
                writeLog('切换悬浮窗模式失败: ' + error.message, 'ERROR');
                ElMessage.error('切换悬浮窗模式失败');
            }
        },
        // 添加 GitHub 链接处理函数
        async openGitHub() {
            try {
                await ipcRenderer.invoke('open-external-link', 'https://github.com/fh4606/MinioPG');
            } catch (error) {
                console.error('打开 GitHub 链接失败:', error);
                ElMessage.error('打开 GitHub 链接失败');
            }
        },
    },
    computed: {
        // 根据勾选的筛选条件过滤文件列表
        filteredList() {
            return this.fileList.filter(item => {
                // 文件夹筛选
                if (item.isFolder) {
                    return this.showFolders;
                }
                
                // 判断是否为图片
                const isImage = this.isImageFile(item.name);
                
                // 图片筛选
                if (isImage) {
                    return this.showImages;
                }
                
                // 其它文件筛选
                return this.showOthers;
            });
        }
    },
    watch: {
        // 监听筛选条件变化
        showFolders() {
            this.applyFilters();
        },
        showImages() {
            this.applyFilters();
        },
        showOthers() {
            this.applyFilters();
        },
        // 监听原始文件列表变化
        fileList: {
            handler() {
                this.applyFilters();
            },
            deep: true
        },
        // 当显示目录选择器时加载可用目录
        showDirectorySelector: {
            async handler(newValue) {
                if (newValue) {
                    console.log('显示目录选择对话框');
                    try {
                        await this.loadAvailableDirectories();
                        this.tempSelectedDirectory = this.currentUploadPath;
                    } catch (error) {
                        console.error('加载目录时出错:', error);
                        ElMessage.error(`加载目录列表失败: ${error.message}`);
                    }
                }
            }
        }
    },
    mounted() {
        writeLog('应用程序启动');
        this.loadConfig();
        
        // 初始化筛选列表
        this.filteredFileList = [...this.fileList];
    }
});

// 注册 Element Plus 组件
app.use(ElementPlus);

// 注册图标组件
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
    app.component(key, component);
}

app.mount('#app'); 
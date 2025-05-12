# Minio PicGo

一个基于 Electron 的现代化图片上传工具，支持多种图床服务。软件UI借鉴了PicGO。首次配置完成后请重启下软件，防止软件文件列表刷新不成功的问题。

## 功能特点

- 支持拖拽上传图片
- 支持复制粘贴上传
- 上传历史记录
- 一键复制图片链接
- 现代化的用户界面

## 开发环境要求

- Node.js >= 14.0.0
- npm >= 6.0.0

## 安装

1. 克隆仓库
```bash
git clone https://github.com/yourusername/minio-picgo.git
cd minio-picgo
```

2. 安装依赖
```bash
npm install
```

3. 运行开发版本
```bash
npm run dev
```

4. 构建应用
```bash
npm run build
```

## 使用说明

1. 启动应用后，首先在右侧配置面板中设置图床信息
2. 可以通过拖拽图片到上传区域或点击选择图片按钮来上传图片
3. 上传成功后，图片链接会自动显示在历史记录中
4. 点击复制按钮可以快速复制图片链接

## 配置说明

### Minio 配置
- Endpoint: Minio 服务器地址
- Access Key: 访问密钥
- Secret Key: 密钥
- Bucket: 存储桶名称

## 开发计划

- [ ] 添加更多图床支持
- [ ] 支持图片压缩
- [ ] 支持自定义上传后的图片链接格式
- [ ] 添加快捷键支持
- [ ] 支持插件系统

## 许可证

MIT 

const builder = require('electron-builder');
const Platform = builder.Platform;

// Promise是一个异步操作的代理对象
function pack() {
    // 删除dist文件夹
    require('fs').rmSync('./dist', { recursive: true, force: true });
    
    // 开始打包
    builder.build({
        targets: Platform.WINDOWS.createTarget(),
        config: {
            // 使用package.json中的配置
            // 额外的配置可以在这里添加
        }
    })
    .then((result) => {
        console.log('打包成功:', result);
    })
    .catch((error) => {
        console.error('打包失败:', error);
    });
}

pack(); 
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const log = require('electron-log');

// 配置日志
log.transports.file.level = 'info';
log.transports.console.level = 'info';

// 记录应用启动
log.info('应用启动...');

let mainWindow;

// 创建窗口
function createWindow() {
  log.info('创建窗口...');

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 400,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // 开发模式连接到 React dev server
  const isDev = !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'build', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  log.info('窗口创建完成');
}

app.whenReady().then(() => {
  log.info('App ready');
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  log.info('所有窗口已关闭');
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  log.info('应用即将退出');
});

const { app, BrowserWindow, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { startAdminServer, DEFAULT_ADMIN_PORT } = require('../license/admin-dashboard');

app.name = 'SastraKeygenAdmin';
if (process.platform === 'win32') {
  app.setAppUserModelId('com.sastraai.keygenadmin');
}

const adminDataDir = path.join(app.getPath('appData'), 'SastraKeygen_Admin');
if (!fs.existsSync(adminDataDir)) {
  fs.mkdirSync(adminDataDir, { recursive: true });
}
app.setPath('userData', adminDataDir);

let adminWindow = null;

async function createAdminWindow() {
  const { url } = await startAdminServer(DEFAULT_ADMIN_PORT);

  const iconPath = path.join(__dirname, '..', 'assets', 'icon.ico');
  const winIcon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;

  adminWindow = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#040715',
    autoHideMenuBar: true,
    title: 'SastraGetWay — Admin Cloud Control Center (24/7 Firebase)',
    icon: winIcon,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  adminWindow.loadURL(url);

  adminWindow.webContents.setWindowOpenHandler(({ url: extUrl }) => {
    shell.openExternal(extUrl);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createAdminWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

const { fork } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain, session } = require("electron");
const {
  createBaselineProfile,
  deleteBaselineProfile,
  getBaselineStorePath,
  readBaselineStore,
  renameBaselineProfile,
  selectBaselineProfile,
} = require("./baseline-store.cjs");

const STARTUP_TIMEOUT_MS = 30_000;

let mainWindow = null;
let dashboardWindow = null;
let nextServer = null;
let appOrigin = null;
let monitoringActive = false;

function isTrustedAppUrl(value) {
  try {
    return Boolean(appOrigin && new URL(value).origin === appOrigin);
  } catch {
    return false;
  }
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;

      server.close((error) => {
        if (error) reject(error);
        else if (port) resolve(port);
        else reject(new Error("无法分配本地端口。"));
      });
    });
  });
}

function waitForServer(url) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) {
          resolve();
          return;
        }
        retry();
      });

      request.on("error", retry);
      request.setTimeout(1_000, () => request.destroy());
    };

    const retry = () => {
      if (nextServer && nextServer.exitCode !== null) {
        reject(new Error("内置服务在启动期间意外退出。"));
      } else if (Date.now() >= deadline) {
        reject(new Error("等待内置服务启动超时。"));
      } else {
        setTimeout(check, 150);
      }
    };

    check();
  });
}

async function startNextServer() {
  const developmentUrl = !app.isPackaged ? process.env.ELECTRON_START_URL : null;

  if (developmentUrl) {
    appOrigin = new URL(developmentUrl).origin;
    await waitForServer(appOrigin);
    return;
  }

  const port = await getAvailablePort();
  const serverRoot = app.isPackaged
    ? path.join(process.resourcesPath, "next")
    : path.join(__dirname, "..", ".next", "standalone");
  const serverEntry = path.join(serverRoot, "server.js");
  const bundledNodeModules = app.isPackaged
    ? path.join(process.resourcesPath, "app.asar", "node_modules")
    : path.join(serverRoot, "node_modules");
  const nodePath = [bundledNodeModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);

  nextServer = fork(serverEntry, [], {
    cwd: serverRoot,
    env: {
      ...process.env,
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
      NODE_PATH: nodePath,
      PORT: String(port),
    },
    silent: true,
  });

  nextServer.stdout?.on("data", (chunk) => process.stdout.write(chunk));
  nextServer.stderr?.on("data", (chunk) => process.stderr.write(chunk));

  appOrigin = `http://127.0.0.1:${port}`;
  await waitForServer(appOrigin);
}

function configurePermissions() {
  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin, details) => {
      if (permission !== "media" || !isTrustedAppUrl(requestingOrigin)) {
        return false;
      }

      const mediaTypes = details?.mediaType ? [details.mediaType] : [];
      return mediaTypes.length === 0 || mediaTypes.every((type) => type === "video");
    }
  );

  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const mediaTypes = details.mediaTypes ?? [];
      const isCameraOnly = mediaTypes.length === 0 || mediaTypes.every((type) => type === "video");
      const allowed =
        permission === "media" && isTrustedAppUrl(webContents.getURL()) && isCameraOnly;

      callback(allowed);
    }
  );
}

function configureBaselineStorage() {
  const storePath = getBaselineStorePath(app.getPath("home"));
  const handle = (channel, handler) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedAppUrl(event.senderFrame.url)) {
        throw new Error("拒绝来自非应用页面的本地数据请求。");
      }
      return handler(...args);
    });
  };

  handle("baselines:list", async () => ({
    ...(await readBaselineStore(storePath)),
    configPath: storePath,
  }));
  handle("baselines:create", async (name, baseline) => ({
    ...(await createBaselineProfile(storePath, name, baseline)),
    configPath: storePath,
  }));
  handle("baselines:select", async (id) => ({
    ...(await selectBaselineProfile(storePath, id)),
    configPath: storePath,
  }));
  handle("baselines:rename", async (id, name) => ({
    ...(await renameBaselineProfile(storePath, id, name)),
    configPath: storePath,
  }));
  handle("baselines:delete", async (id) => ({
    ...(await deleteBaselineProfile(storePath, id)),
    configPath: storePath,
  }));
}

function configureWindowSecurity(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedAppUrl(url)) event.preventDefault();
  });
}

function createAppWindow({ backgroundThrottling = true } = {}) {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "Posture Sentinel",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
      backgroundThrottling,
    },
  });

  configureWindowSecurity(window);
  return window;
}

function getAppRoute(value) {
  try {
    const url = new URL(value, appOrigin);
    if (!appOrigin || url.origin !== appOrigin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function focusWindow(window) {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

async function openDashboard(route) {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) {
    const window = createAppWindow();
    dashboardWindow = window;
    window.on("closed", () => {
      if (dashboardWindow === window) dashboardWindow = null;
      if (monitoringActive) focusWindow(mainWindow);
    });
  }

  const window = dashboardWindow;
  await window.loadURL(new URL(route, appOrigin).toString());
  if (!window || window.isDestroyed()) return;

  focusWindow(window);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
}

function showMonitoringWindow() {
  focusWindow(mainWindow);

  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    const window = dashboardWindow;
    dashboardWindow = null;
    window.close();
  }
}

function configureMonitoringNavigation() {
  ipcMain.on("monitoring:set-active", (event, active) => {
    if (!isTrustedAppUrl(event.senderFrame.url)) return;
    if (mainWindow?.webContents !== event.sender) return;
    monitoringActive = active === true;
  });

  ipcMain.handle("monitoring:navigate", async (event, target) => {
    if (!isTrustedAppUrl(event.senderFrame.url)) {
      throw new Error("拒绝来自非应用页面的导航请求。");
    }

    const route = getAppRoute(target);
    if (!route || !monitoringActive) return false;
    const pathname = new URL(route, appOrigin).pathname;

    if (mainWindow?.webContents === event.sender && pathname !== "/detect") {
      await openDashboard(route);
      return true;
    }

    if (dashboardWindow?.webContents === event.sender && pathname === "/detect") {
      showMonitoringWindow();
      return true;
    }

    return false;
  });

  ipcMain.on("monitoring:sync-route", (event, target) => {
    if (!isTrustedAppUrl(event.senderFrame.url) || !monitoringActive) return;
    const route = getAppRoute(target);
    if (!route || new URL(route, appOrigin).pathname !== "/detect") return;

    if (dashboardWindow?.webContents === event.sender) showMonitoringWindow();
  });
}

async function createWindow() {
  mainWindow = createAppWindow({ backgroundThrottling: false });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
    monitoringActive = false;
  });

  await mainWindow.loadURL(appOrigin);
}

function stopNextServer() {
  if (nextServer && nextServer.exitCode === null) nextServer.kill();
  nextServer = null;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (dashboardWindow?.isVisible()) focusWindow(dashboardWindow);
    else focusWindow(mainWindow);
  });

  app.whenReady().then(async () => {
    try {
      await startNextServer();
      configurePermissions();
      configureBaselineStorage();
      configureMonitoringNavigation();
      await createWindow();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox("Posture Sentinel 启动失败", message);
      app.quit();
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0 && appOrigin) {
        void createWindow();
      } else if (dashboardWindow?.isVisible()) {
        focusWindow(dashboardWindow);
      } else {
        focusWindow(mainWindow);
      }
    });
  });

  app.on("before-quit", stopNextServer);
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

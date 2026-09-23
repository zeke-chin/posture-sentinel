const { fork } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { app, BrowserWindow, dialog, session } = require("electron");

const STARTUP_TIMEOUT_MS = 30_000;

let mainWindow = null;
let nextServer = null;
let appOrigin = null;

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

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "Posture Sentinel",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedAppUrl(url)) event.preventDefault();
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
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
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      await startNextServer();
      configurePermissions();
      await createWindow();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox("Posture Sentinel 启动失败", message);
      app.quit();
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0 && appOrigin) {
        void createWindow();
      }
    });
  });

  app.on("before-quit", stopNextServer);
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

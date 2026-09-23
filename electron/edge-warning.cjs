const { BrowserWindow, screen } = require("electron");

const FADE_OUT_MS = 450;
const SPREAD_DURATION_MS = 14_000;

const overlayHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <style>
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
    #glow {
      position: fixed;
      inset: 0;
      width: 100%;
      height: 100%;
      opacity: 0;
      transition: opacity 420ms ease-out;
      pointer-events: none;
    }
  </style>
</head>
<body>
  <canvas id="glow"></canvas>
  <script>
    const glow = document.getElementById('glow');
    const context = glow.getContext('2d', { alpha: true });
    let frame = 0;
    let start = 0;
    let lastPaint = 0;
    let distances = new Float32Array(0);
    let pixels;

    function resize() {
      glow.width = Math.min(Math.ceil(innerWidth / 2), 960);
      glow.height = Math.min(Math.ceil(innerHeight / 2), 540);
      pixels = context.createImageData(glow.width, glow.height);
      distances = new Float32Array(glow.width * glow.height);
      for (let y = 0; y < glow.height; y++) {
        for (let x = 0; x < glow.width; x++) {
          // 0 at any edge, 1 at the center; each display gets its own field.
          distances[y * glow.width + x] = Math.min(
            (2 * x) / (glow.width - 1),
            (2 * (glow.width - 1 - x)) / (glow.width - 1),
            (2 * y) / (glow.height - 1),
            (2 * (glow.height - 1 - y)) / (glow.height - 1)
          );
        }
      }
    }

    function paint(progress) {
      const eased = progress * progress * (3 - 2 * progress);
      // 1 is the center: stop just past halfway there, leaving the center clear.
      const reach = 0.16 + eased * 0.39;
      // The outside edge deepens independently while the red band spreads inward.
      const edgeOpacity = 0.09 + 0.39 * Math.pow(progress, 1.15);
      const data = pixels.data;
      for (let i = 0; i < distances.length; i++) {
        const distance = distances[i];
        const front = Math.max(0, Math.min(1, (reach - distance) / 0.16));
        const smoothFront = front * front * (3 - 2 * front);
        const inwardFade = 1 - 0.45 * Math.min(distance / 0.55, 1);
        const offset = i * 4;
        data[offset] = 239;
        data[offset + 1] = 68;
        data[offset + 2] = 68;
        data[offset + 3] = Math.round(255 * edgeOpacity * inwardFade * smoothFront);
      }
      context.putImageData(pixels, 0, 0);
    }

    function advance(now) {
      const progress = Math.min((now - start) / ${SPREAD_DURATION_MS}, 1);
      if (now - lastPaint >= 32 || progress === 1) {
        paint(progress);
        lastPaint = now;
      }
      if (progress < 1) frame = requestAnimationFrame(advance);
    }

    window.edgeWarningStart = () => {
      cancelAnimationFrame(frame);
      resize();
      paint(0);
      glow.style.opacity = '1';
      start = performance.now();
      lastPaint = start;
      frame = requestAnimationFrame(advance);
    };
    window.edgeWarningStop = () => {
      cancelAnimationFrame(frame);
      glow.style.opacity = '0';
    };
    addEventListener('resize', () => {
      if (glow.style.opacity !== '0') {
        resize();
        paint(Math.min((performance.now() - start) / ${SPREAD_DURATION_MS}, 1));
      }
    });
  </script>
</body>
</html>`;

function createEdgeWarning() {
  const overlays = new Map();
  let automaticActive = false;
  let destroyTimer = null;
  let generation = 0;

  function ensureOverlays() {
    const displays = screen.getAllDisplays();
    const displayIds = new Set(displays.map((display) => display.id));

    for (const [id, entry] of overlays) {
      if (displayIds.has(id)) continue;
      entry.window.destroy();
      overlays.delete(id);
    }

    for (const display of displays) {
      const existing = overlays.get(display.id);
      if (existing) {
        if (!existing.window.isDestroyed()) existing.window.setBounds(display.bounds);
        continue;
      }

      const window = new BrowserWindow({
        ...display.bounds,
        show: false,
        frame: false,
        transparent: true,
        hasShadow: false,
        focusable: false,
        skipTaskbar: true,
        backgroundColor: "#00000000",
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      window.setIgnoreMouseEvents(true, { forward: true });
      window.setAlwaysOnTop(true, "screen-saver");
      if (process.platform === "darwin") {
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      }
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());

      const ready = window.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(overlayHtml)}`
      );
      overlays.set(display.id, { window, ready });
    }

    return [...overlays.values()];
  }

  async function show() {
    clearTimeout(destroyTimer);
    const currentGeneration = ++generation;
    const entries = ensureOverlays();

    await Promise.all(entries.map((entry) => entry.ready));
    if (!automaticActive || currentGeneration !== generation) return;

    for (const { window } of entries) {
      if (window.isDestroyed()) continue;
      const wasVisible = window.isVisible();
      if (!wasVisible) window.showInactive();
      if (!wasVisible) {
        void window.webContents
          .executeJavaScript("window.edgeWarningStart()")
          .catch((error) => console.error("启动坐姿警告动画失败：", error));
      }
    }
  }

  function hide() {
    ++generation;
    for (const { window } of overlays.values()) {
      if (!window.isDestroyed() && window.isVisible()) {
        void window.webContents
          .executeJavaScript("window.edgeWarningStop()")
          .catch((error) => console.error("停止坐姿警告动画失败：", error));
      }
    }

    clearTimeout(destroyTimer);
    destroyTimer = setTimeout(() => {
      if (automaticActive) return;
      for (const { window } of overlays.values()) {
        if (!window.isDestroyed()) window.destroy();
      }
      overlays.clear();
    }, FADE_OUT_MS);
  }

  function sync() {
    if (automaticActive) {
      void show().catch((error) => console.error("显示坐姿警告失败：", error));
    } else {
      hide();
    }
  }

  for (const event of ["display-added", "display-removed", "display-metrics-changed"]) {
    screen.on(event, () => {
      if (automaticActive) sync();
    });
  }

  return {
    setAutomaticActive(active) {
      const next = active === true;
      if (automaticActive === next) return;
      automaticActive = next;
      sync();
    },
    stop() {
      automaticActive = false;
      sync();
    },
  };
}

module.exports = { createEdgeWarning };

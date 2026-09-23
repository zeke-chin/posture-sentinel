const fs = require("node:fs");
const path = require("node:path");
const { app, Menu, nativeImage, Tray } = require("electron");
const sharp = require("sharp");

const ICONS = {
  good: { file: "option-a-good.svg", sample: "100", label: "坐姿良好" },
  warning: { file: "option-a-warning.svg", sample: "80", label: "请注意坐姿" },
  bad: { file: "option-a-bad.svg", sample: "50", label: "坐姿不良" },
};

const svgTemplates = Object.fromEntries(
  Object.entries(ICONS).map(([status, icon]) => [
    status,
    fs.readFileSync(path.join(__dirname, "assets", "tray", icon.file), "utf8"),
  ])
);

async function renderImage(score, status) {
  const icon = ICONS[status] ?? ICONS.good;
  const displayScore = score === null ? "--" : String(score);
  let svg = svgTemplates[status] ?? svgTemplates.good;
  svg = svg.replace(`>${icon.sample}</text>`, `>${displayScore}</text>`);

  if (score === null) {
    svg = svg.replaceAll("#10b981", "#ffffff");
  }

  const png = await sharp(Buffer.from(svg), { density: 144 }).png().toBuffer();
  const image = nativeImage.createFromBuffer(png, { scaleFactor: 2 });
  if (image.isEmpty()) throw new Error("无法生成菜单栏图标。");
  return image;
}

async function createStatusTray(openDetection) {
  const neutralImage = await renderImage(null, null);
  const tray = new Tray(neutralImage);
  const imageCache = new Map([["idle", neutralImage]]);
  let requestedKey = "idle";

  tray.setToolTip("体态哨兵 · 未在监测");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开实时检测", click: openDetection },
      { type: "separator" },
      { label: "退出体态哨兵", click: () => app.quit() },
    ])
  );

  return {
    update(score, status) {
      const valid =
        Number.isInteger(score) && score >= 0 && score <= 100 && Object.hasOwn(ICONS, status);
      const currentScore = valid ? score : null;
      const currentStatus = valid ? status : null;
      const key = valid ? `${status}:${score}` : "idle";
      if (key === requestedKey) return;
      requestedKey = key;

      const label = currentStatus ? `${ICONS[currentStatus].label} · ${currentScore} 分` : "未在监测";
      tray.setToolTip(`体态哨兵 · ${label}`);

      const cached = imageCache.get(key);
      if (cached) {
        tray.setImage(cached);
        return;
      }

      void renderImage(currentScore, currentStatus)
        .then((image) => {
          imageCache.set(key, image);
          if (requestedKey === key) tray.setImage(image);
        })
        .catch((error) => console.error("更新菜单栏图标失败：", error));
    },
  };
}

module.exports = { createStatusTray };

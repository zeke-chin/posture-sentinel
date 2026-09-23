const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..");
const standaloneRoot = path.join(projectRoot, ".next", "standalone");

if (!fs.existsSync(path.join(standaloneRoot, "server.js"))) {
  throw new Error("找不到 .next/standalone/server.js，请先运行 bun run build。");
}

const copies = [
  [path.join(projectRoot, "public"), path.join(standaloneRoot, "public")],
  [path.join(projectRoot, ".next", "static"), path.join(standaloneRoot, ".next", "static")],
];

for (const [source, destination] of copies) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

console.log("Next.js standalone 资源已准备完成。");

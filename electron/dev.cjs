const { spawn } = require("node:child_process");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..");
const developmentPort = "3100";
const developmentUrl = `http://127.0.0.1:${developmentPort}`;
const nextEntry = path.join(projectRoot, "node_modules", "next", "dist", "bin", "next");
const electronEntry = require("electron");

const children = new Set();
let shuttingDown = false;

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    ...options,
  });

  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);

    if (!shuttingDown) {
      const exitCode = signal ? 1 : (code ?? 0);
      shutdown(exitCode);
    } else if (children.size === 0) {
      process.exit(process.exitCode ?? 0);
    }
  });

  return child;
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;

  shuttingDown = true;
  process.exitCode = exitCode;

  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }

  const forceQuitTimer = setTimeout(() => {
    for (const child of children) {
      if (!child.killed) child.kill("SIGKILL");
    }
    process.exit(process.exitCode ?? 1);
  }, 5_000);
  forceQuitTimer.unref();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0));
}

function main() {
  start(process.execPath, [nextEntry, "dev", "--hostname", "127.0.0.1", "--port", developmentPort]);
  start(electronEntry, [projectRoot], {
    env: {
      ...process.env,
      ELECTRON_START_URL: developmentUrl,
    },
  });
}

main();

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const STORE_VERSION = 1;
const MAX_BASELINE_BYTES = 1_000_000;

function getBaselineStorePath(homeDirectory) {
  return path.join(homeDirectory, ".config", "posture-sentinel", "calibrations.json");
}

function createEmptyStore() {
  return { version: STORE_VERSION, activeId: null, profiles: [] };
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validateBaseline(baseline) {
  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) {
    throw new Error("校准数据格式无效。");
  }

  for (const key of ["headTilt", "shoulderTilt", "neckForward", "spineTilt", "capturedAt"]) {
    if (!isFiniteNumber(baseline[key])) throw new Error(`校准字段 ${key} 无效。`);
  }

  const serialized = JSON.stringify(baseline);
  if (Buffer.byteLength(serialized, "utf8") > MAX_BASELINE_BYTES) {
    throw new Error("校准数据大小超出限制。");
  }

  return JSON.parse(serialized);
}

function normalizeName(name) {
  if (typeof name !== "string") throw new Error("基线名称无效。");
  const printableName = [...name]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? " " : character;
    })
    .join("");
  const normalized = printableName.replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error("基线名称不能为空。");
  return normalized.slice(0, 60);
}

function normalizeStore(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.profiles)) {
    throw new Error("校准文件格式无效。");
  }

  const profiles = value.profiles.flatMap((profile) => {
    try {
      if (!profile || typeof profile.id !== "string") return [];
      return [
        {
          id: profile.id,
          name: normalizeName(profile.name),
          createdAt: isFiniteNumber(profile.createdAt) ? profile.createdAt : Date.now(),
          updatedAt: isFiniteNumber(profile.updatedAt) ? profile.updatedAt : Date.now(),
          baseline: validateBaseline(profile.baseline),
        },
      ];
    } catch {
      return [];
    }
  });
  const activeId = profiles.some((profile) => profile.id === value.activeId)
    ? value.activeId
    : (profiles[0]?.id ?? null);

  return { version: STORE_VERSION, activeId, profiles };
}

async function readBaselineStore(storePath) {
  try {
    const contents = await fs.readFile(storePath, "utf8");
    return normalizeStore(JSON.parse(contents));
  } catch (error) {
    if (error?.code === "ENOENT") return createEmptyStore();
    throw error;
  }
}

async function writeBaselineStore(storePath, store) {
  const normalized = normalizeStore(store);
  const directory = path.dirname(storePath);
  const temporaryPath = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(temporaryPath, storePath);
    await fs.chmod(storePath, 0o600);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
  return normalized;
}

async function createBaselineProfile(storePath, name, baseline) {
  const store = await readBaselineStore(storePath);
  const now = Date.now();
  const profile = {
    id: crypto.randomUUID(),
    name: normalizeName(name),
    createdAt: now,
    updatedAt: now,
    baseline: validateBaseline(baseline),
  };
  store.profiles.unshift(profile);
  store.activeId = profile.id;
  return writeBaselineStore(storePath, store);
}

async function selectBaselineProfile(storePath, id) {
  const store = await readBaselineStore(storePath);
  if (!store.profiles.some((profile) => profile.id === id)) {
    throw new Error("找不到要启用的基线。");
  }
  store.activeId = id;
  return writeBaselineStore(storePath, store);
}

async function renameBaselineProfile(storePath, id, name) {
  const store = await readBaselineStore(storePath);
  const profile = store.profiles.find((item) => item.id === id);
  if (!profile) throw new Error("找不到要重命名的基线。");
  profile.name = normalizeName(name);
  profile.updatedAt = Date.now();
  return writeBaselineStore(storePath, store);
}

async function deleteBaselineProfile(storePath, id) {
  const store = await readBaselineStore(storePath);
  const nextProfiles = store.profiles.filter((profile) => profile.id !== id);
  if (nextProfiles.length === store.profiles.length) {
    throw new Error("找不到要删除的基线。");
  }
  store.profiles = nextProfiles;
  if (store.activeId === id) store.activeId = nextProfiles[0]?.id ?? null;
  return writeBaselineStore(storePath, store);
}

module.exports = {
  createBaselineProfile,
  deleteBaselineProfile,
  getBaselineStorePath,
  readBaselineStore,
  renameBaselineProfile,
  selectBaselineProfile,
};

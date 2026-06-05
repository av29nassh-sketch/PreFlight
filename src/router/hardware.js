const { execFileSync } = require("node:child_process");
const os = require("node:os");

const DEFAULT_THRESHOLDS = Object.freeze({
  minCpuCores: 8,
  minRamBytes: 16 * 1024 ** 3,
  minVramBytes: 6 * 1024 ** 3
});

function parseNvidiaSmiBytes(output) {
  if (typeof output !== "string") {
    return 0;
  }

  return output
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter(Number.isFinite)
    .reduce((totalMiB, valueMiB) => totalMiB + valueMiB, 0) * 1024 ** 2;
}

function probeNvidiaVramBytes(execFile = execFileSync) {
  try {
    const output = execFile("nvidia-smi", [
      "--query-gpu=memory.total",
      "--format=csv,noheader,nounits"
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500
    });
    return parseNvidiaSmiBytes(output);
  } catch {
    return 0;
  }
}

function getHardwareProfile(options = {}) {
  const cpuCores = Number.isFinite(options.cpuCores) ? options.cpuCores : os.cpus().length;
  const totalRamBytes = Number.isFinite(options.totalRamBytes) ? options.totalRamBytes : os.totalmem();
  const vramBytes = Number.isFinite(options.vramBytes)
    ? options.vramBytes
    : probeNvidiaVramBytes(options.execFile);

  return {
    cpuCores,
    totalRamBytes,
    vramBytes
  };
}

function evaluateHardware(options = {}) {
  const thresholds = {
    ...DEFAULT_THRESHOLDS,
    ...(options.thresholds || {})
  };
  const profile = getHardwareProfile(options);

  return (
    profile.cpuCores >= thresholds.minCpuCores &&
    profile.totalRamBytes >= thresholds.minRamBytes &&
    profile.vramBytes >= thresholds.minVramBytes
  );
}

module.exports = {
  DEFAULT_THRESHOLDS,
  evaluateHardware,
  getHardwareProfile,
  parseNvidiaSmiBytes,
  probeNvidiaVramBytes
};

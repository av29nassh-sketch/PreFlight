const chalk = require("chalk");

function shouldUseColor(options = {}) {
  if (options.noColor === true || options.color === false) {
    return false;
  }

  const stream = options.stream || process.stdout;
  return Boolean(stream && stream.isTTY);
}

function getChalk(options = {}) {
  return shouldUseColor(options) ? new chalk.Instance({ level: 1 }) : null;
}

function colorize(level, message, options = {}) {
  const c = getChalk(options);
  if (!c) {
    return message;
  }

  const normalizedLevel = String(level || "").toLowerCase();
  if (normalizedLevel === "critical" || normalizedLevel === "error" || normalizedLevel === "high") {
    return c.red.bold(message);
  }

  if (normalizedLevel === "warning" || normalizedLevel === "warn" || normalizedLevel === "moderate" || normalizedLevel === "low") {
    return c.yellow(message);
  }

  if (normalizedLevel === "success") {
    return c.green.bold(message);
  }

  return message;
}

function createLogger(options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const color = options.color;
  const noColor = options.noColor;

  return {
    error(message) {
      stderr.write(`${colorize("error", message, { color, noColor, stream: stderr })}\n`);
    },
    log(message) {
      stdout.write(`${message}\n`);
    },
    success(message) {
      stdout.write(`${colorize("success", message, { color, noColor, stream: stdout })}\n`);
    },
    warn(message) {
      stderr.write(`${colorize("warning", message, { color, noColor, stream: stderr })}\n`);
    }
  };
}

module.exports = {
  colorize,
  createLogger,
  shouldUseColor
};

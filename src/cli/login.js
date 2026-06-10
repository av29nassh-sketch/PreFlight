const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const http = require("node:http");
const { URL } = require("node:url");
const { readConfig, writeConfig } = require("../licensing/licenseManager");

const DEFAULT_AUTH_BASE_URL = "https://preflight-vibe.vercel.app";
const DEFAULT_LOGIN_PORT = 4242;
const DEFAULT_LOGIN_HOST = "127.0.0.1";

function htmlPage({ title, body }) {
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\" />",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
    `<title>${title}</title>`,
    "<style>",
    "body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;display:grid;min-height:100vh;place-items:center;margin:0}",
    "main{max-width:520px;padding:32px;border:1px solid #334155;border-radius:12px;background:#111827;box-shadow:0 24px 80px rgba(0,0,0,.35)}",
    "h1{font-size:24px;margin:0 0 12px}p{line-height:1.6;color:#cbd5e1;margin:0}",
    "</style>",
    "</head>",
    "<body>",
    `<main><h1>${title}</h1><p>${body}</p></main>`,
    "</body>",
    "</html>"
  ].join("");
}

function openBrowser(url, options = {}) {
  if (typeof options.openBrowser === "function") {
    return options.openBrowser(url);
  }

  const platform = options.platform || process.platform;
  const command = platform === "win32"
    ? "cmd"
    : platform === "darwin"
      ? "open"
      : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = childProcess.spawn(command, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  return child;
}

function listen(server, { port, host }) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server.address());
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function listenOnAvailablePort(server, options = {}) {
  const host = options.host || DEFAULT_LOGIN_HOST;
  const preferredPort = Number(options.port || DEFAULT_LOGIN_PORT);
  const maxAttempts = Number(options.maxAttempts || 25);

  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const port = preferredPort + offset;
    try {
      return await listen(server, { port, host });
    } catch (error) {
      if (error.code !== "EADDRINUSE" || offset === maxAttempts - 1) {
        throw error;
      }
    }
  }

  throw new Error("Could not find an available localhost port for PreFlight login.");
}

function buildAuthUrl({ dashboardUrl, port, state }) {
  const url = new URL("/cli/auth", dashboardUrl || DEFAULT_AUTH_BASE_URL);
  url.searchParams.set("port", String(port));
  url.searchParams.set("state", state);
  return url.toString();
}

async function startCliLogin(options = {}) {
  const state = options.state || crypto.randomBytes(16).toString("hex");
  const timeoutMs = Number(options.timeoutMs || 120000);
  let server;
  let timeoutHandle;

  const loginPromise = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      server?.close(() => {
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      });
    };

    server = http.createServer(async (req, res) => {
      try {
        const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
        if (req.method !== "GET" || requestUrl.pathname !== "/callback") {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
          return;
        }

        const callbackState = requestUrl.searchParams.get("state");
        if (callbackState !== state) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(htmlPage({
            title: "PreFlight Login Failed",
            body: "The login state did not match. Please close this tab and run preflight login again."
          }));
          finish(new Error("PreFlight login callback state mismatch."));
          return;
        }

        const token = requestUrl.searchParams.get("token")?.trim();
        if (!token) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(htmlPage({
            title: "PreFlight Login Failed",
            body: "No license token was returned by the dashboard."
          }));
          finish(new Error("PreFlight login callback did not include a license token."));
          return;
        }

        const config = await readConfig(options);
        await writeConfig({
          ...config,
          licenseKey: token
        }, options);

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(htmlPage({
          title: "PreFlight CLI Authorized",
          body: "You can close this browser tab and return to your terminal."
        }));
        finish(null, { token, configPath: options.configPath, state });
      } catch (error) {
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(htmlPage({
          title: "PreFlight Login Failed",
          body: "The local CLI callback could not be completed."
        }));
        finish(error);
      }
    });

    timeoutHandle = setTimeout(() => {
      finish(new Error("PreFlight login timed out waiting for browser authorization."));
    }, timeoutMs);
  });

  const address = await listenOnAvailablePort(server, {
    host: options.host,
    port: options.port,
    maxAttempts: options.maxAttempts
  });
  const authUrl = buildAuthUrl({
    dashboardUrl: options.dashboardUrl || process.env.PREFLIGHT_DASHBOARD_URL || DEFAULT_AUTH_BASE_URL,
    port: address.port,
    state
  });
  await openBrowser(authUrl, options);

  return {
    authUrl,
    port: address.port,
    result: loginPromise
  };
}

module.exports = {
  DEFAULT_AUTH_BASE_URL,
  DEFAULT_LOGIN_HOST,
  DEFAULT_LOGIN_PORT,
  buildAuthUrl,
  listenOnAvailablePort,
  openBrowser,
  startCliLogin
};

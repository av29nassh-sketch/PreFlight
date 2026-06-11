const https = require("node:https");

const DEFAULT_PREFLIGHT_PROXY_ENDPOINT = "https://preflight-proxy.vercel.app/api/v1/remediate";

function buildPreflightProxyRequest(options = {}) {
  const endpoint = typeof options.endpoint === "string" && options.endpoint.trim()
    ? options.endpoint.trim()
    : DEFAULT_PREFLIGHT_PROXY_ENDPOINT;
  const licenseKey = typeof options.licenseKey === "string" ? options.licenseKey.trim() : "";
  const system = typeof options.system === "string" ? options.system : "";
  const userContent = typeof options.userContent === "string" ? options.userContent : "";
  const maxTokens = Number(options.maxTokens);
  const temperature = options.temperature;

  if (!licenseKey) {
    throw new Error("PreFlight proxy request requires a license key.");
  }

  if (!system.trim()) {
    throw new Error("PreFlight proxy request requires a system prompt.");
  }

  if (!userContent.trim()) {
    throw new Error("PreFlight proxy request requires user content.");
  }

  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new Error("PreFlight proxy request requires a positive maxTokens value.");
  }

  const payload = {
    system,
    max_tokens: Math.trunc(maxTokens),
    messages: [
      {
        role: "user",
        content: userContent
      }
    ]
  };

  if (temperature !== undefined) {
    payload.temperature = temperature;
  }

  return {
    endpoint,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PreFlight-Pro-Key": licenseKey
    },
    payload
  };
}

function extractPreflightProxyText(response) {
  if (!response || typeof response !== "object") {
    throw new Error("PreFlight proxy response must be a JSON object.");
  }

  const content = Array.isArray(response.content) ? response.content : [];
  const textBlock = content.find(
    (item) =>
      item &&
      typeof item === "object" &&
      typeof item.text === "string" &&
      item.text.trim() !== ""
  );

  if (!textBlock) {
    throw new Error("PreFlight proxy response did not include response.content[0].text.");
  }

  return textBlock.text.trim();
}

async function requestPreflightProxy(options = {}) {
  const request = buildPreflightProxyRequest(options);
  if (typeof options.transport === "function") {
    return options.transport(request);
  }

  const timeoutMs = Number(options.timeoutMs);
  const resolvedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000;

  return new Promise((resolve, reject) => {
    const url = new URL(request.endpoint);
    const body = JSON.stringify(request.payload);
    const req = https.request(
      url,
      {
        method: request.method,
        headers: {
          ...request.headers,
          "Content-Length": Buffer.byteLength(body)
        }
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          const status = response.statusCode || 500;
          if (status < 200 || status >= 300) {
            const error = new Error(responseBody || `Proxy request failed with status ${status}.`);
            error.status = status;
            reject(error);
            return;
          }

          try {
            resolve(JSON.parse(responseBody || "{}"));
          } catch (error) {
            reject(new Error(`PreFlight proxy returned invalid JSON: ${error.message}`));
          }
        });
      }
    );

    req.setTimeout(resolvedTimeout, () => {
      req.destroy(new Error("PreFlight proxy request timed out."));
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

module.exports = {
  DEFAULT_PREFLIGHT_PROXY_ENDPOINT,
  buildPreflightProxyRequest,
  extractPreflightProxyText,
  requestPreflightProxy
};

import { createServer as createHttpServer } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { loadToolHubConfig } from "./core/config.mjs";
import { createToolHubServer } from "./core/server.mjs";

function isLoopbackHost(host) {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost";
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body, "utf8"),
    "cache-control": "no-store"
  });
  res.end(body);
}

export async function serveHostedHttp() {
  const initialConfig = await loadToolHubConfig();
  const httpConfig = initialConfig.http ?? {};

  const host = httpConfig.host ?? "127.0.0.1";
  const port = httpConfig.port ?? 3333;
  const mcpPath = httpConfig.path ?? "/mcp";
  const allowPublicBind = httpConfig.allow_public_bind === true;

  if (!isLoopbackHost(host) && !allowPublicBind) {
    throw new Error(
      `Refusing non-loopback HTTP bind ${host} without http.allow_public_bind: true. ` +
      "Preferred deployment is loopback ToolHub behind an HTTPS reverse proxy."
    );
  }

  // Fail early before accepting network traffic. This also performs child-MCP
  // discovery for enabled proxy modules; their process-global runtimes are
  // reused by later per-request server factories.
  await createToolHubServer(initialConfig);

  const handler = createMcpHandler(async () => {
    const config = await loadToolHubConfig();
    return await createToolHubServer(config);
  }, {
    onerror(error) {
      console.error(error?.stack ?? error?.message ?? String(error));
    }
  });

  const nodeMcpHandler = toNodeHandler(handler, {
    onerror(error) {
      console.error(error?.stack ?? error?.message ?? String(error));
    }
  });

  const server = createHttpServer((req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url ?? "/", "http://toolhub.local").pathname;
    } catch {
      json(res, 400, { ok: false, error: "invalid request URL" });
      return;
    }

    if (req.method === "GET" && pathname === "/healthz") {
      json(res, 200, {
        ok: true,
        service: "mcp-toolhub",
        transport: "streamable-http"
      });
      return;
    }

    if (req.method === "GET" && pathname === "/readyz") {
      json(res, 200, {
        ok: true,
        service: "mcp-toolhub",
        ready: true
      });
      return;
    }

    if (pathname !== mcpPath) {
      json(res, 404, { ok: false, error: "not found" });
      return;
    }

    void nodeMcpHandler(req, res);
  });

  const shutdown = async (signal) => {
    console.error(`MCP-ToolHub hosted HTTP shutting down on ${signal}`);
    server.close();
    try {
      await handler.close();
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  console.error(`MCP-ToolHub hosted HTTP listening on http://${host}:${port}${mcpPath}`);
  console.error("Terminate TLS and authenticate callers at the reverse proxy.");
}

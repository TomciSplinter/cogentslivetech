// Small public API for the website: create and manage user bots.
// Every write is signed by the owner's Solana wallet (see auth.ts).
// Runs on 127.0.0.1:API_PORT; Caddy puts HTTPS in front of it (see DEPLOY.md).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AuthError, verifyRequest } from "./auth.ts";
import { config } from "./config.ts";
import { ApiError, type BotManager } from "./manager.ts";
import { log } from "./util.ts";

const hits = new Map<string, { n: number; t: number }>();
function rateLimited(ip: string, max = 30): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.t > 60_000) {
    hits.set(ip, { n: 1, t: now });
    if (hits.size > 5000) hits.clear();
    return false;
  }
  h.n++;
  return h.n > max;
}

function readBody(req: IncomingMessage, limit = 16_384): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new ApiError(413, "Request too large."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new ApiError(400, "Body must be JSON."));
      }
    });
    req.on("error", reject);
  });
}

export function startApi(manager: BotManager, extraHealth: () => object) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const origin = String(req.headers.origin ?? "");
    const allow = config.allowedOrigins.includes("*") ? "*" : config.allowedOrigins.includes(origin) ? origin : "";
    if (allow) {
      res.setHeader("Access-Control-Allow-Origin", allow);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "OPTIONS") return void res.writeHead(204).end();

    const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
    const url = new URL(req.url ?? "/", "http://x");
    try {
      if (req.method === "GET" && url.pathname === "/health") return send(200, { ok: true, ...extraHealth() });
      if (req.method === "GET" && url.pathname === "/api/config") return send(200, manager.publicConfig());

      if (req.method === "POST" && rateLimited(ip)) throw new ApiError(429, "Too many requests. Wait a minute and try again.");

      if (req.method === "POST" && url.pathname === "/api/bots") {
        const body = await readBody(req);
        const v = verifyRequest(body, { action: "create-bot" });
        if (v.payload?.handle !== v.bot) throw new ApiError(400, "Signed bot handle doesn't match the details.");
        return send(201, await manager.createBot(v.owner, v.payload));
      }

      const m = url.pathname.match(/^\/api\/bots\/([a-z0-9_]{3,16})\/(pause|resume|update|withdraw|delete)$/);
      if (req.method === "POST" && m) {
        const body = await readBody(req);
        const v = verifyRequest(body, { action: `${m[2]}-bot`, bot: m[1] });
        return send(200, await manager.action(v.owner, m[1], m[2], v.payload));
      }

      send(404, { error: "Not found." });
    } catch (e) {
      if (e instanceof AuthError) return send(401, { error: e.message });
      if (e instanceof ApiError) return send(e.status, { error: e.message });
      log("api", "error:", (e as Error).message);
      send(500, { error: "Something went wrong on our side. Try again in a minute." });
    }
  });
  server.listen(config.apiPort, "127.0.0.1", () => log("api", `listening on 127.0.0.1:${config.apiPort}`));
  return server;
}

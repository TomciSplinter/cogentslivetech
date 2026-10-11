// Small public API for the website: create and manage user bots.
// Every write is signed by the owner's Solana wallet (see auth.ts).
// Runs on 127.0.0.1:API_PORT; Caddy puts HTTPS in front of it (see DEPLOY.md).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AuthError, verifyRequest } from "./auth.ts";
import { config } from "./config.ts";
import { ApiError, type BotManager } from "./manager.ts";
import { CANDLE_MS, type Coin, type Market } from "./market.ts";
import { log } from "./util.ts";

// ---------------------------------------------------------------- live chart feed (Server-Sent Events)
// GET /api/live?mint=... streams one coin: the last 15 minutes of 1-second candles once, then every
// trade within ~250ms. The website and Cogents TV draw the chart from this, like a trading terminal.
const LIVE_HISTORY = 900; // 1-second candles sent on connect (15 minutes)
const LIVE_MAX_CLIENTS = 1500;
const LIVE_MAX_PER_IP = 8;
const liveClients = new Map<string, number>(); // ip -> open streams
let liveTotal = 0;

const trim = (ks: Coin["candles"]) => ks.map((k) => [k[0], +k[1].toFixed(3), +k[2].toFixed(3), +k[3].toFixed(3), +k[4].toFixed(3), +k[5].toFixed(3)]);

function coinSummary(c: Coin) {
  return { mint: c.mint, symbol: c.symbol, name: c.name, mcap_sol: c.mcapSol, price_sol: c.priceSol, progress: c.progress, created_at: new Date(c.createdAt).toISOString() };
}

function liveStream(req: IncomingMessage, res: ServerResponse, market: Market, mint: string, ip: string) {
  const perIp = liveClients.get(ip) ?? 0;
  if (liveTotal >= LIVE_MAX_CLIENTS || perIp >= LIVE_MAX_PER_IP) {
    res.writeHead(429, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return void res.end(JSON.stringify({ error: "Too many live streams open." }));
  }
  liveTotal++;
  liveClients.set(ip, perIp + 1);
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true, 30_000);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  let known = false;
  const sendHistory = () => {
    const c = market.getCoin(mint);
    if (!c) return void send("history", { now: Date.now(), coin: null, candles: [] });
    known = true;
    send("history", { now: Date.now(), ms: CANDLE_MS, coin: coinSummary(c), candles: trim(c.candles.slice(-LIVE_HISTORY)) });
  };
  sendHistory();

  // coalesce bursts of trades into one message every 250ms
  let dirty = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    flushTimer = undefined;
    if (!dirty) return;
    dirty = false;
    const c = market.getCoin(mint);
    if (!c) return;
    send("tick", { now: Date.now(), candles: trim(c.candles.slice(-2)), mcap_sol: c.mcapSol, price_sol: c.priceSol, progress: c.progress });
  };
  const unsub = market.onTick((c) => {
    if (c.mint !== mint) return;
    dirty = true;
    if (!flushTimer) flushTimer = setTimeout(flush, 250);
  });
  // keep the connection warm through proxies; also pick up a coin the engine learns about later
  const ping = setInterval(() => {
    if (!known && market.getCoin(mint)) sendHistory();
    res.write(`: ping ${Date.now()}\n\n`);
  }, 15_000);

  const close = () => {
    unsub();
    clearInterval(ping);
    if (flushTimer) clearTimeout(flushTimer);
    liveTotal--;
    const n = (liveClients.get(ip) ?? 1) - 1;
    if (n <= 0) liveClients.delete(ip);
    else liveClients.set(ip, n);
  };
  req.on("close", close);
  res.on("error", close);
}

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

export function startApi(manager: BotManager, extraHealth: () => object, market?: Market) {
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
      if (req.method === "GET" && url.pathname === "/api/live") {
        const mint = url.searchParams.get("mint") ?? "";
        if (!market) throw new ApiError(503, "Live feed not available.");
        if (!/^[A-Za-z0-9]{8,64}$/.test(mint)) throw new ApiError(400, "Bad mint.");
        return liveStream(req, res, market, mint, ip);
      }

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

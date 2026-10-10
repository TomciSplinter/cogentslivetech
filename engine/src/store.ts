// Where everything is saved. SupabaseStore talks to your Supabase project over
// its REST API. MemoryStore keeps data in memory (tests / quick local runs).
import { config } from "./config.ts";
import { fetchT, log } from "./util.ts";

export interface BotRow {
  id: string;
  name: string;
  role: string;
  color: string;
  mode: "paper" | "real";
  wallet?: string | null;
  sol_balance: number;
  start_sol: number;
  status: string;
  thinking: string;
  watching_mint?: string | null;
  trades_today: number;
  updated_at?: string;
  // user bots
  owner?: string | null;
  preset?: string | null;
  persona_bio?: string | null;
  voice_id?: string | null;
  limits?: Record<string, number> | null;
  is_house?: boolean;
  paused?: boolean;
  created_at?: string;
  // performance (for the leaderboard)
  realized_pnl?: number;
  wins?: number;
  losses?: number;
  volume_sol?: number;
  withdrawn_sol?: number;
  live_since?: string;
}

export interface TvRow {
  bot_id: string | null;
  since: string;
}

export interface PositionRow {
  bot_id: string;
  mint: string;
  symbol: string;
  tokens: number;
  cost_sol: number;
  entry_price: number;
  opened_at: string;
}

export interface TradeRow {
  bot_id: string;
  mint: string;
  symbol: string;
  side: "buy" | "sell";
  sol: number;
  tokens: number;
  price: number;
  pnl_sol?: number | null;
  reason?: string | null;
  tx?: string | null;
  mode: "paper" | "real";
  created_at?: string;
}

export interface UtteranceRow {
  bot_id: string;
  kind: "trade" | "think" | "chat" | "idle" | "system";
  text: string;
  audio_url?: string | null;
  reply_to?: string | null;
  created_at?: string;
}

export interface ChatRow {
  id: number;
  bot_id: string;
  username: string;
  text: string;
  created_at: string;
}

export interface CoinRow {
  mint: string;
  symbol: string;
  name: string;
  mcap_sol: number;
  price_sol: number;
  progress: number;
  created_at: string;
  history: [number, number][];
  candles: [number, number, number, number, number, number][];
  updated_at: string;
}

export interface Store {
  upsertBots(rows: BotRow[]): Promise<void>;
  insertBot(row: BotRow): Promise<void>;
  getBot(id: string): Promise<BotRow | undefined>;
  listUserBots(): Promise<BotRow[]>;
  deleteBot(id: string): Promise<void>;
  setBotSecret(botId: string, secretEnc: string): Promise<void>;
  getBotSecret(botId: string): Promise<string | undefined>;
  getTv(): Promise<TvRow | undefined>;
  setTv(botId: string | null): Promise<void>;
  setSolUsd(usd: number): Promise<void>;
  insertChat(row: { bot_id: string; viewer_id: string; username: string; text: string }): Promise<void>;
  /** New chat for ALL bots since an id (one query instead of one per bot). */
  newChatAll(afterId: number): Promise<ChatRow[]>;
  latestChatIdAll(): Promise<number>;
  /** Viewer counts for all bots in one query. */
  viewerCounts(): Promise<Map<string, number>>;
  updateBot(id: string, patch: Partial<BotRow>): Promise<void>;
  getPositions(botId: string): Promise<PositionRow[]>;
  upsertPosition(row: PositionRow): Promise<void>;
  deletePosition(botId: string, mint: string): Promise<void>;
  insertTrade(row: TradeRow): Promise<void>;
  tradesSince(botId: string, sinceIso: string): Promise<TradeRow[]>;
  insertUtterance(row: UtteranceRow): Promise<void>;
  uploadAudio(path: string, mp3: Uint8Array): Promise<string | undefined>;
  newChat(botId: string, afterId: number): Promise<ChatRow[]>;
  latestChatId(botId: string): Promise<number>;
  viewerCount(botId: string): Promise<number>;
  upsertCoins(rows: CoinRow[]): Promise<void>;
  cleanup(): Promise<void>;
}

// ---------------------------------------------------------------------------

export class SupabaseStore implements Store {
  private base: string;
  private key: string;

  constructor() {
    this.base = config.supabaseUrl;
    this.key = config.supabaseSecretKey;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { apikey: this.key, "Content-Type": "application/json", ...extra };
    // Legacy JWT keys also go in Authorization; new sb_secret_ keys only need apikey.
    if (!this.key.startsWith("sb_")) h.Authorization = `Bearer ${this.key}`;
    return h;
  }

  private async rest(method: string, path: string, body?: unknown, prefer?: string): Promise<any> {
    const res = await fetchT(`${this.base}/rest/v1/${path}`, {
      method,
      headers: this.headers(prefer ? { Prefer: prefer } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Supabase ${method} ${path.split("?")[0]} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async upsertBots(rows: BotRow[]) {
    await this.rest("POST", "bots?on_conflict=id", rows, "resolution=merge-duplicates,return=minimal");
  }
  async insertBot(row: BotRow) {
    await this.rest("POST", "bots", row, "return=minimal");
  }
  async getBot(id: string) {
    const r = await this.rest("GET", `bots?id=eq.${encodeURIComponent(id)}&select=*`);
    return r?.[0];
  }
  async listUserBots() {
    return (await this.rest("GET", "bots?is_house=eq.false&select=*&order=created_at.asc")) ?? [];
  }
  async deleteBot(id: string) {
    await this.rest("DELETE", `bots?id=eq.${encodeURIComponent(id)}`, undefined, "return=minimal");
  }
  async setBotSecret(botId: string, secretEnc: string) {
    await this.rest("POST", "bot_secrets?on_conflict=bot_id", { bot_id: botId, secret_enc: secretEnc }, "resolution=merge-duplicates,return=minimal");
  }
  async getBotSecret(botId: string) {
    const r = await this.rest("GET", `bot_secrets?bot_id=eq.${encodeURIComponent(botId)}&select=secret_enc`);
    return r?.[0]?.secret_enc;
  }
  async getTv() {
    const r = await this.rest("GET", "tv_state?id=eq.1&select=bot_id,since");
    return r?.[0];
  }
  async setTv(botId: string | null) {
    await this.rest("POST", "tv_state?on_conflict=id", { id: 1, bot_id: botId, since: new Date().toISOString() }, "resolution=merge-duplicates,return=minimal");
  }
  async setSolUsd(usd: number) {
    await this.rest("POST", "tv_state?on_conflict=id", { id: 1, sol_usd: usd }, "resolution=merge-duplicates,return=minimal");
  }
  async insertChat(row: { bot_id: string; viewer_id: string; username: string; text: string }) {
    await this.rest("POST", "chat_messages", row, "return=minimal");
  }
  async newChatAll(afterId: number) {
    return (await this.rest("GET", `chat_messages?id=gt.${afterId}&select=id,bot_id,username,text,created_at&order=id.asc&limit=200`)) ?? [];
  }
  async latestChatIdAll() {
    const r = await this.rest("GET", "chat_messages?select=id&order=id.desc&limit=1");
    return r?.[0]?.id ?? 0;
  }
  async viewerCounts() {
    const since = new Date(Date.now() - 45_000).toISOString();
    const r: { bot_id: string }[] = (await this.rest("GET", `viewers?last_seen=gte.${encodeURIComponent(since)}&select=bot_id`)) ?? [];
    const m = new Map<string, number>();
    for (const v of r) m.set(v.bot_id, (m.get(v.bot_id) ?? 0) + 1);
    return m;
  }
  async updateBot(id: string, patch: Partial<BotRow>) {
    await this.rest("PATCH", `bots?id=eq.${encodeURIComponent(id)}`, { ...patch, updated_at: new Date().toISOString() }, "return=minimal");
  }
  async getPositions(botId: string) {
    return (await this.rest("GET", `positions?bot_id=eq.${encodeURIComponent(botId)}&select=*`)) ?? [];
  }
  async upsertPosition(row: PositionRow) {
    await this.rest("POST", "positions?on_conflict=bot_id,mint", row, "resolution=merge-duplicates,return=minimal");
  }
  async deletePosition(botId: string, mint: string) {
    await this.rest("DELETE", `positions?bot_id=eq.${encodeURIComponent(botId)}&mint=eq.${encodeURIComponent(mint)}`, undefined, "return=minimal");
  }
  async insertTrade(row: TradeRow) {
    await this.rest("POST", "trades", row, "return=minimal");
  }
  async tradesSince(botId: string, sinceIso: string) {
    return (await this.rest("GET", `trades?bot_id=eq.${encodeURIComponent(botId)}&created_at=gte.${encodeURIComponent(sinceIso)}&select=*&order=created_at.asc`)) ?? [];
  }
  async insertUtterance(row: UtteranceRow) {
    await this.rest("POST", "utterances", row, "return=minimal");
  }
  async uploadAudio(path: string, mp3: Uint8Array) {
    const res = await fetchT(`${this.base}/storage/v1/object/voice/${path}`, {
      method: "POST",
      headers: { ...this.headers({ "Content-Type": "audio/mpeg", "x-upsert": "true", "cache-control": "3600" }) },
      body: Buffer.from(mp3),
    });
    if (!res.ok) {
      log("store", `audio upload failed HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return undefined;
    }
    return `${this.base}/storage/v1/object/public/voice/${path}`;
  }
  async newChat(botId: string, afterId: number) {
    return (
      (await this.rest("GET", `chat_messages?bot_id=eq.${encodeURIComponent(botId)}&id=gt.${afterId}&select=id,bot_id,username,text,created_at&order=id.asc&limit=20`)) ?? []
    );
  }
  async latestChatId(botId: string) {
    const r = await this.rest("GET", `chat_messages?bot_id=eq.${encodeURIComponent(botId)}&select=id&order=id.desc&limit=1`);
    return r?.[0]?.id ?? 0;
  }
  async viewerCount(botId: string) {
    const since = new Date(Date.now() - 45_000).toISOString();
    const r = await this.rest("GET", `viewers?bot_id=eq.${encodeURIComponent(botId)}&last_seen=gte.${encodeURIComponent(since)}&select=viewer_id`);
    return r?.length ?? 0;
  }
  async upsertCoins(rows: CoinRow[]) {
    if (rows.length) await this.rest("POST", "coins?on_conflict=mint", rows, "resolution=merge-duplicates,return=minimal");
  }
  async cleanup() {
    const iso = (ms: number) => encodeURIComponent(new Date(Date.now() - ms).toISOString());
    await this.rest("DELETE", `coins?updated_at=lt.${iso(3 * 3600_000)}`, undefined, "return=minimal");
    await this.rest("DELETE", `viewers?last_seen=lt.${iso(3600_000)}`, undefined, "return=minimal");
    await this.rest("DELETE", `chat_messages?created_at=lt.${iso(7 * 86400_000)}`, undefined, "return=minimal");
    await this.rest("DELETE", `utterances?created_at=lt.${iso(7 * 86400_000)}`, undefined, "return=minimal");
    // old voice clips: list the bucket and remove files older than 6 hours
    try {
      const res = await fetchT(`${this.base}/storage/v1/object/list/voice`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ prefix: "", limit: 1000, sortBy: { column: "created_at", order: "asc" } }),
      });
      if (!res.ok) return;
      const folders: any[] = await res.json();
      const old: string[] = [];
      for (const f of folders) {
        if (f.id) continue; // file at root (not expected)
        const r2 = await fetchT(`${this.base}/storage/v1/object/list/voice`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ prefix: f.name, limit: 1000, sortBy: { column: "created_at", order: "asc" } }),
        });
        if (!r2.ok) continue;
        for (const file of (await r2.json()) as any[]) {
          if (file.created_at && Date.now() - Date.parse(file.created_at) > 6 * 3600_000) old.push(`${f.name}/${file.name}`);
        }
      }
      if (old.length) {
        await fetchT(`${this.base}/storage/v1/object/voice`, { method: "DELETE", headers: this.headers(), body: JSON.stringify({ prefixes: old }) });
      }
    } catch (e) {
      log("store", "voice cleanup skipped:", (e as Error).message);
    }
  }
}

// ---------------------------------------------------------------------------

/** Keeps everything in memory. Used by tests and when no Supabase is set. */
export class MemoryStore implements Store {
  bots = new Map<string, BotRow>();
  positions: PositionRow[] = [];
  trades: TradeRow[] = [];
  utterances: UtteranceRow[] = [];
  chat: ChatRow[] = [];
  coins = new Map<string, CoinRow>();
  secrets = new Map<string, string>();
  tv: TvRow | undefined;
  viewers = 0;
  viewersByBot = new Map<string, number>();
  private chatSeq = 1000;

  async upsertBots(rows: BotRow[]) {
    for (const r of rows) this.bots.set(r.id, { ...this.bots.get(r.id), ...r });
  }
  async insertBot(row: BotRow) {
    if (this.bots.has(row.id)) throw new Error("duplicate key value violates unique constraint");
    this.bots.set(row.id, { ...row, created_at: new Date().toISOString() });
  }
  async listUserBots() {
    return [...this.bots.values()].filter((b) => b.is_house === false);
  }
  async deleteBot(id: string) {
    this.bots.delete(id);
    this.positions = this.positions.filter((p) => p.bot_id !== id);
    this.secrets.delete(id);
  }
  async setBotSecret(botId: string, secretEnc: string) {
    this.secrets.set(botId, secretEnc);
  }
  async getBotSecret(botId: string) {
    return this.secrets.get(botId);
  }
  async getTv() {
    return this.tv;
  }
  async setTv(botId: string | null) {
    this.tv = { bot_id: botId, since: new Date().toISOString() };
  }
  solUsd = 0;
  async setSolUsd(usd: number) {
    this.solUsd = usd;
  }
  async insertChat(row: { bot_id: string; viewer_id: string; username: string; text: string }) {
    this.chat.push({ id: ++this.chatSeq, bot_id: row.bot_id, username: row.username, text: row.text, created_at: new Date().toISOString() });
  }
  async newChatAll(afterId: number) {
    return this.chat.filter((c) => c.id > afterId).sort((a, b) => a.id - b.id);
  }
  async latestChatIdAll() {
    return this.chat.reduce((m, c) => Math.max(m, c.id), 0);
  }
  async viewerCounts() {
    const m = new Map(this.viewersByBot);
    if (this.viewers) for (const id of this.bots.keys()) if (!m.has(id)) m.set(id, this.viewers);
    return m;
  }
  async getBot(id: string) {
    return this.bots.get(id);
  }
  async updateBot(id: string, patch: Partial<BotRow>) {
    const b = this.bots.get(id);
    if (b) Object.assign(b, patch);
  }
  async getPositions(botId: string) {
    return this.positions.filter((p) => p.bot_id === botId);
  }
  async upsertPosition(row: PositionRow) {
    this.positions = this.positions.filter((p) => !(p.bot_id === row.bot_id && p.mint === row.mint));
    this.positions.push(row);
  }
  async deletePosition(botId: string, mint: string) {
    this.positions = this.positions.filter((p) => !(p.bot_id === botId && p.mint === mint));
  }
  async insertTrade(row: TradeRow) {
    this.trades.push({ ...row, created_at: row.created_at ?? new Date().toISOString() });
  }
  async tradesSince(botId: string, sinceIso: string) {
    return this.trades.filter((t) => t.bot_id === botId && (t.created_at ?? "") >= sinceIso);
  }
  async insertUtterance(row: UtteranceRow) {
    this.utterances.push({ ...row, created_at: new Date().toISOString() });
  }
  async uploadAudio() {
    return undefined;
  }
  async newChat(botId: string, afterId: number) {
    return this.chat.filter((c) => c.bot_id === botId && c.id > afterId);
  }
  async latestChatId(botId: string) {
    return this.chat.filter((c) => c.bot_id === botId).reduce((m, c) => Math.max(m, c.id), 0);
  }
  async viewerCount() {
    return this.viewers;
  }
  async upsertCoins(rows: CoinRow[]) {
    for (const r of rows) this.coins.set(r.mint, r);
  }
  async cleanup() {}
}

export function createStore(): Store {
  if (config.supabaseUrl && config.supabaseSecretKey) return new SupabaseStore();
  log("store", "no Supabase configured: using memory only (nothing is saved, website won't see it)");
  return new MemoryStore();
}

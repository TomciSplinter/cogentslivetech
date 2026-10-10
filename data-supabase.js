// Live data from your Supabase project (what the engine writes),
// plus the engine's API for creating and managing user bots.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

export function createSupabaseSource(url, key, apiUrl) {
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const rows = (r) => {
    if (r.error) throw r.error;
    return r.data ?? [];
  };
  const api = async (path, body) => {
    if (!apiUrl) throw new Error("Bot creation isn't connected yet (API_URL is empty in config.js).");
    let res;
    try {
      res = await fetch(`${apiUrl.replace(/\/$/, "")}${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
    } catch {
      throw new Error("Couldn't reach the Cogents server. Check your connection and try again.");
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error ?? `Request failed (${res.status}).`);
    return j;
  };

  return {
    live: true,
    async listBots() {
      return rows(await sb.from("bots").select("*").neq("status", "deleted").order("created_at"));
    },
    async getBot(id) {
      return rows(await sb.from("bots").select("*").eq("id", id).limit(1))[0];
    },
    async getPositions(id) {
      return rows(await sb.from("positions").select("*").eq("bot_id", id).order("opened_at"));
    },
    async getAllPositions() {
      return rows(await sb.from("positions").select("*"));
    },
    async getTrades(id, limit = 20) {
      let q = sb.from("trades").select("*").order("created_at", { ascending: false }).limit(limit);
      if (id) q = q.eq("bot_id", id);
      return rows(await q);
    },
    async getUtterances(botId, limit = 30) {
      let q = sb.from("utterances").select("*").order("created_at", { ascending: false }).limit(limit);
      if (botId) q = q.eq("bot_id", botId);
      return rows(await q);
    },
    async getChat(botId, limit = 60) {
      return rows(await sb.from("chat_messages").select("id,bot_id,username,text,created_at").eq("bot_id", botId).order("id", { ascending: false }).limit(limit)).reverse();
    },
    async getMovers(limit = 8) {
      // the freshest snapshots, busiest first (volume over the last ~5 minutes of candles)
      const list = rows(await sb.from("coins").select("mint,symbol,mcap_sol,created_at,candles").order("updated_at", { ascending: false }).limit(20));
      const vol = (c) => (c.candles ?? []).slice(-20).reduce((x, k) => x + (Number(k[5]) || 0), 0);
      return list
        .sort((a, b) => vol(b) - vol(a))
        .slice(0, limit)
        .map((c) => ({ ...c, candles: (c.candles ?? []).slice(-40) }));
    },
    async getCoins(mints) {
      if (!mints.length) return [];
      return rows(await sb.from("coins").select("mint,symbol,price_sol").in("mint", mints.slice(0, 200)));
    },
    async getCoin(mint) {
      return rows(await sb.from("coins").select("mint,symbol,name,mcap_sol,price_sol,progress,created_at,candles,updated_at").eq("mint", mint).limit(1))[0];
    },
    async getTv() {
      return rows(await sb.from("tv_state").select("bot_id,since").eq("id", 1).limit(1))[0];
    },
    subscribe({ onUtterance, onChat, onTrade, onBot }) {
      const ch = sb
        .channel(`cogents-live-${Math.random().toString(36).slice(2)}`)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "utterances" }, (p) => onUtterance?.(p.new))
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages" }, (p) => onChat?.(p.new))
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "trades" }, (p) => onTrade?.(p.new))
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "bots" }, (p) => onBot?.(p.new))
        .subscribe();
      return () => sb.removeChannel(ch);
    },
    async sendChat(botId, username, text, viewerId) {
      const r = await sb.from("chat_messages").insert({ bot_id: botId, username, text, viewer_id: viewerId });
      if (r.error) throw new Error(r.error.message.includes("slow down") ? "You're typing fast. Wait a second and send again." : "Message didn't send. Check your connection and try again.");
    },
    async viewerCount(botId) {
      const since = new Date(Date.now() - 45_000).toISOString();
      const r = await sb.from("viewers").select("viewer_id", { count: "exact", head: true }).eq("bot_id", botId).gte("last_seen", since);
      return r.count ?? 0;
    },
    async heartbeat(botId, viewerId) {
      await sb.from("viewers").upsert({ bot_id: botId, viewer_id: viewerId, last_seen: new Date().toISOString() }, { onConflict: "bot_id,viewer_id" });
    },
    api: {
      config: () => api("/api/config"),
      create: (signed) => api("/api/bots", signed),
      action: (id, action, signed) => api(`/api/bots/${id}/${action}`, signed),
    },
  };
}

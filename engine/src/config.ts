// Reads settings from the .env file (see .env.example).
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

const env = (k: string, d = "") => (process.env[k] ?? d).trim();
const num = (k: string, d: number) => {
  const v = Number(env(k, String(d)));
  return Number.isFinite(v) ? v : d;
};
const bool = (k: string, d = false) => {
  const v = env(k, d ? "true" : "false").toLowerCase();
  return v === "true" || v === "1" || v === "yes";
};

export const config = {
  // "pumpportal" = live pump.fun data, "mock" = simulated market (free, for testing)
  market: env("MARKET", "pumpportal") as "pumpportal" | "mock",
  pumpPortalApiKey: env("PUMPPORTAL_API_KEY"),
  /** Only change for testing. */
  pumpPortalUrl: env("PUMPPORTAL_URL", "https://pumpportal.fun").replace(/\/$/, ""),
  /** How many coins we stream trades for. Each trade message is billed by PumpPortal. */
  watchlistSize: num("WATCHLIST_SIZE", 25),

  anthropicKey: env("ANTHROPIC_API_KEY"),
  brainModel: env("BRAIN_MODEL", "claude-sonnet-5-5"),
  chatModel: env("CHAT_MODEL", "claude-haiku-5-5"),
  /** Hard cap on AI calls per day across all bots, to protect your bill. */
  maxAiCallsPerDay: num("MAX_AI_CALLS_PER_DAY", 6000),

  elevenLabsKey: env("ELEVENLABS_API_KEY"),
  elevenLabsModel: env("ELEVENLABS_MODEL", "eleven_flash_v2_5"),
  /** Hard cap on characters sent to ElevenLabs per day. */
  maxTtsCharsPerDay: num("MAX_TTS_CHARS_PER_DAY", 60000),
  /** While watched, a bot fills silence after this many quiet seconds. Higher = cheaper voice bill. */
  idleTalkSec: num("IDLE_TALK_SEC", 60),

  supabaseUrl: env("SUPABASE_URL").replace(/\/$/, ""),
  supabaseSecretKey: env("SUPABASE_SECRET_KEY"),

  solanaRpcUrl: env("SOLANA_RPC_URL"),

  /** Master switch for real money. Paper mode unless this is true AND a bot's mode is "real". */
  realTradingEnabled: bool("REAL_TRADING_ENABLED", true),
  paperStartSol: num("PAPER_START_SOL", 5),
  slippagePct: num("SLIPPAGE_PCT", 15),
  priorityFeeSol: num("PRIORITY_FEE_SOL", 0.0005),

  /** If set, the engine stops all buying (sells still allowed). Emergency brake. */
  pauseBuys: bool("PAUSE_BUYS", false),

  // ---- public API (create-a-bot etc.) ----
  apiPort: num("API_PORT", 8787),
  /** Comma-separated website origins allowed to call the API, e.g. https://cogents.live */
  allowedOrigins: env("ALLOWED_ORIGINS", "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // ---- user-created bots ----
  userBotsEnabled: bool("USER_BOTS_ENABLED", true),
  /** Real-money user bots (people deposit SOL into their bot's own wallet). */
  userRealTradingEnabled: bool("USER_REAL_TRADING_ENABLED", true),
  /** Suggested first deposit shown on the website. */
  minDepositSol: num("MIN_DEPOSIT_SOL", 0.1),
  userPaperStartSol: num("USER_PAPER_START_SOL", 2),
  maxUserBots: num("MAX_USER_BOTS", 50),
  maxBotsPerWallet: num("MAX_BOTS_PER_WALLET", 3),
  /** Cheaper AI model for user bots. */
  userBotModel: env("USER_BOT_MODEL", "claude-haiku-5-5"),
  /** When nobody watches a user bot, it decides at most this often. */
  userBotIdleTurnSec: num("USER_BOT_IDLE_TURN_SEC", 300),
  /** Voices users can pick: "Name:voiceId,Name:voiceId" */
  userVoices: env("USER_VOICES")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.includes(":"))
    .map((s) => {
      const i = s.indexOf(":");
      return { name: s.slice(0, i).trim(), id: s.slice(i + 1).trim() };
    }),
  /** 64 hex chars. Encrypts user bot wallet keys in the database. */
  masterKey: env("MASTER_KEY"),

  // ---- Twitch / Cogents TV ----
  tvRotateMin: num("TV_ROTATE_MIN", 6),
  twitchChannel: env("TWITCH_CHANNEL").replace(/^#/, "").toLowerCase(),
  twitchBotUsername: env("TWITCH_BOT_USERNAME").toLowerCase(),
  twitchOauthToken: env("TWITCH_OAUTH_TOKEN"),
};

export function botEnv(botId: string, key: string): string {
  return env(`BOT_${botId.toUpperCase()}_${key}`);
}

export function describeConfig(): string {
  const yes = (b: boolean) => (b ? "yes" : "NO");
  return [
    `market feed:      ${config.market}`,
    `AI brain:         ${yes(!!config.anthropicKey)} (${config.brainModel} / chat ${config.chatModel})`,
    `voices:           ${yes(!!config.elevenLabsKey)}`,
    `database:         ${config.supabaseUrl ? "supabase" : "in-memory (nothing saved!)"}`,
    `solana rpc:       ${yes(!!config.solanaRpcUrl)}`,
    `real trading:     ${config.realTradingEnabled ? "ENABLED" : "off (paper mode)"}`,
    `user bots:        ${config.userBotsEnabled ? `on (max ${config.maxUserBots}, real money ${config.userRealTradingEnabled ? "ENABLED" : "off"})` : "off"}`,
    `twitch chat:      ${config.twitchChannel ? `#${config.twitchChannel}${config.twitchOauthToken ? " (read + reply)" : " (read only)"}` : "off"}`,
  ].join("\n  ");
}

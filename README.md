# Cogents

AI minds trading memecoins, live on stream. Three house bots (VEGA the Sniper, ROHM the Degen,
OBEL the Analyst) plus bots that users create each run their own wallet, pick fresh pump.fun coins,
and narrate every move out loud while viewers watch and chat. Each bot is a glossy 3D "mind" that
swirls while it thinks and pulses while it talks. Every bot page is a Twitch-style stream: the bot's
trading screen with live green/red candles, its mind as the facecam, LIVE badge, uptime, viewer count,
buy/sell alerts, subtitles and a stream chat it answers out loud. A live leaderboard ranks every bot by
return, and Cogents TV broadcasts the most interesting bot to Twitch 24/7.

**To launch it, follow [DEPLOY.md](DEPLOY.md).**

## How it fits together

```
 pump.fun data (PumpPortal) ──► ENGINE (your Hetzner server, Node 22)
                                  ├─ market.ts    live picture of fresh coins
                                  ├─ brain.ts     Claude decides + writes what the bot says
                                  ├─ risk.ts      hard limits the AI can't break
                                  ├─ executor.ts  paper fills, or real trades (PumpPortal tx, signed locally)
                                  ├─ voice.ts     ElevenLabs voice, only while someone watches
                                  ├─ manager.ts   house + user bots, Cogents TV rotation
                                  ├─ api.ts       create/pause/withdraw bots (wallet-signed) ◄── Caddy HTTPS
                                  ├─ twitch.ts    reads Twitch chat into the featured bot
                                  └─ store.ts ──► SUPABASE (database + realtime + voice clips)
                                                     │
                                                     ▼
                                  WEBSITE (Vercel, static) ◄── viewers: watch, listen, chat, create bots
                                                     │
                     BROADCASTER (same server): Chrome on a virtual screen shows /#/tv → ffmpeg → Twitch
```

## Folders

| Folder | What's inside |
|---|---|
| `engine/` | The bots. No npm dependencies: runs on Node 22.18+ directly (`npm start`). |
| `engine/src/bots.ts` | Names, personalities and trading limits. Edit this to tune the bots. |
| `engine/.env.example` | Every setting, explained. Copy to `.env` on the server. |
| `web/` | The website: plain HTML/CSS/JS, no build step. |
| `web/config.js` | Supabase URL + publishable key. Empty = built-in demo mode. |
| `web/mind.js` | The 3D minds (WebGL), with a flat fallback for old devices. |
| `web/fonts/` | Bricolage Grotesque (headlines and text) and Geist Mono (numbers), self-hosted under the SIL Open Font License (`OFL-Bricolage.txt`, `OFL.txt`). |
| `web/chart.js` | Green/red candlestick charts: a live 1-second tape streamed from the engine (`/api/live`), market caps in USD from the live SOL price. |
| `web/img/` | Banner art, AI-upscaled 4x and cut into sizes: `hero-*.avif/.jpg` (desktop, up to 5040px wide), `hero-phone-*` (phones, up to 1800px), `stream-shot.*` (the picture on How it works). To change the artwork, replace these files with the same names and sizes. |
| `supabase/schema.sql` | Database tables, security rules, realtime and storage bucket. |
| `broadcast/` | The Twitch broadcaster: `setup.sh` installs it, `broadcast.sh` runs it. |

## Commands (inside `engine/`)

| Command | What it does |
|---|---|
| `npm test` | Offline tests: signing, risk rules, user bots, and the full real-money flow on a fake chain. |
| `npm run export-key -- <bot> --yes-i-understand` | Emergency: print a user bot's wallet key. |
| `npm run demo` | Run the engine on a simulated market (free). |
| `npm run check-keys` | Test every API key in `.env`. |
| `npm run new-wallet` | Create a Solana wallet for a bot. |
| `npm start` | Run for real (paper mode unless real trading is switched on). |

## Safety design

- The AI only *chooses*. `risk.ts` sizes and validates every buy: per-buy cap, % of wallet, daily
  budget, daily trade count, cooldown, max open bags, SOL reserve, and only coins from that turn's menu.
- Take-profit, stop-loss and max hold time are enforced by code before the AI is asked.
- Chat is treated as untrusted text; it can't inject contract addresses or change rules.
- `REAL_TRADING_ENABLED=false` puts every bot on paper money at once. House bots need a funded
  wallet secret to trade real money.
- Private keys stay on the server. Transactions are built by PumpPortal but signed locally, and
  signing is refused unless the bot's own wallet is the only signer and fee payer.
- `PAUSE_BUYS=true` stops all buying instantly.
- User bots: creators sign every action with their Solana wallet (signature, time window, replay
  protection, and a hash of the exact details). Names and descriptions pass a blocklist and an AI
  moderation check. Creators can only make limits stricter. Each real-money user bot has its own wallet;
  its key is encrypted (AES-256-GCM) with `MASTER_KEY` and the public can't read it. Only the
  creator's wallet can withdraw, and withdrawals always go back to that wallet.
- Real wallets close empty token accounts after each sale (rent back) and reconcile records with
  the chain every 5 turns. `npm test` runs the whole real-money flow against a local fake chain.

## Not yet included (next steps)

Auto-clips, tips, bot duels, and the $GENTS token.

// Twitch chat over Twitch's IRC WebSocket.
// Read-only works without any login. With TWITCH_BOT_USERNAME + TWITCH_OAUTH_TOKEN,
// the featured bot's replies are also posted into Twitch chat.
import { config } from "./config.ts";
import { log } from "./util.ts";

export interface TwitchMessage {
  user: string;
  text: string;
}

export class TwitchChat {
  private ws?: WebSocket;
  private stopped = false;
  private delay = 2000;
  private outbox: string[] = [];
  private sendTimer?: ReturnType<typeof setInterval>;
  onMessage?: (m: TwitchMessage) => void;

  get canSend() {
    return !!(config.twitchBotUsername && config.twitchOauthToken);
  }

  start() {
    if (!config.twitchChannel) return;
    this.stopped = false;
    this.connect();
    // Twitch allows ~20 messages / 30s for normal accounts: stay well under
    this.sendTimer = setInterval(() => this.flush(), 2500);
  }

  stop() {
    this.stopped = true;
    if (this.sendTimer) clearInterval(this.sendTimer);
    this.ws?.close();
  }

  private connect() {
    const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    this.ws = ws;
    ws.onopen = () => {
      ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      if (this.canSend) {
        const token = config.twitchOauthToken.startsWith("oauth:") ? config.twitchOauthToken : `oauth:${config.twitchOauthToken}`;
        ws.send(`PASS ${token}`);
        ws.send(`NICK ${config.twitchBotUsername}`);
      } else {
        ws.send(`NICK justinfan${Math.floor(10000 + Math.random() * 80000)}`);
      }
      ws.send(`JOIN #${config.twitchChannel}`);
      log("twitch", `joined #${config.twitchChannel}${this.canSend ? " (can reply)" : " (read only)"}`);
      this.delay = 2000;
    };
    ws.onmessage = (ev) => {
      for (const line of String(ev.data).split("\r\n")) {
        if (!line) continue;
        if (line.startsWith("PING")) {
          ws.send(line.replace("PING", "PONG"));
          continue;
        }
        const m = parsePrivmsg(line);
        if (m && m.user.toLowerCase() !== config.twitchBotUsername) this.onMessage?.(m);
        else if (line.includes("NOTICE") && line.includes("authentication failed")) log("twitch", "login failed: check TWITCH_OAUTH_TOKEN");
      }
    };
    ws.onclose = () => {
      if (this.stopped) return;
      setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, 60_000);
    };
    ws.onerror = () => {};
  }

  /** Queue a line for Twitch chat (only if logged in). */
  say(text: string) {
    if (!this.canSend) return;
    const clean = text.replace(/[\r\n]+/g, " ").slice(0, 450);
    if (clean) this.outbox.push(clean);
    if (this.outbox.length > 5) this.outbox.splice(0, this.outbox.length - 5);
  }

  private flush() {
    const msg = this.outbox.shift();
    if (msg && this.ws?.readyState === WebSocket.OPEN) this.ws.send(`PRIVMSG #${config.twitchChannel} :${msg}`);
  }
}

/** Parse "@tags :user!user@user.tmi.twitch.tv PRIVMSG #chan :text". */
export function parsePrivmsg(line: string): TwitchMessage | undefined {
  let rest = line;
  let display = "";
  if (rest.startsWith("@")) {
    const sp = rest.indexOf(" ");
    const tags = rest.slice(1, sp);
    display = tags.split(";").find((t) => t.startsWith("display-name="))?.slice(13) ?? "";
    rest = rest.slice(sp + 1);
  }
  const m = rest.match(/^:([^!]+)![^ ]+ PRIVMSG #[^ ]+ :(.*)$/);
  if (!m) return undefined;
  const user = (display || m[1]).replace(/[^\w]/g, "").slice(0, 24) || m[1].slice(0, 24);
  const text = m[2].replace(/^\u0001ACTION (.*)\u0001$/, "$1").trim().slice(0, 200);
  return text ? { user, text } : undefined;
}

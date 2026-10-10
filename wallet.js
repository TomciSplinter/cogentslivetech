// Solana wallet sign-in (Phantom, Solflare, Backpack…).
// Users sign a short message; the engine checks the signature. No passwords.

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return "1".repeat(zeros) + out;
}

async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function provider() {
  const w = window;
  return w.phantom?.solana ?? w.solflare ?? w.backpack?.solana ?? w.backpack ?? (w.solana?.signMessage ? w.solana : null);
}

export const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/** Link that opens this page inside Phantom's in-app browser (for phones). */
export function phantomLink() {
  return `https://phantom.app/ul/browse/${encodeURIComponent(location.href)}?ref=${encodeURIComponent(location.origin)}`;
}

let demoOwner;
export const wallet = {
  address: null,
  demo: false,

  async connect({ allowDemo = false } = {}) {
    const p = provider();
    if (!p) {
      if (allowDemo) {
        demoOwner ??= `Demo${Math.random().toString(36).slice(2, 10)}wa11et`;
        this.address = demoOwner;
        this.demo = true;
        return this.address;
      }
      throw new Error(isMobile ? "Open this page in the Phantom app to connect your wallet." : "No Solana wallet found. Install Phantom or Solflare, then reload.");
    }
    const r = await p.connect();
    this.address = String(r?.publicKey ?? p.publicKey);
    this.demo = false;
    return this.address;
  },

  /** Sign an action like "create-bot" for bot `handle` with these details. */
  async sign(action, bot, details) {
    if (!this.address) await this.connect();
    const payload = JSON.stringify(details ?? {});
    const message = [
      "Cogents wants you to sign in with your Solana account:",
      this.address,
      "",
      `Action: ${action}`,
      `Bot: ${bot}`,
      `Payload: ${await sha256Hex(payload)}`,
      `Issued At: ${new Date().toISOString()}`,
      `Nonce: ${crypto.randomUUID().replace(/-/g, "")}`,
    ].join("\n");
    if (this.demo) return { owner: this.address, message, signature: "demo", payload };
    const p = provider();
    const r = await p.signMessage(new TextEncoder().encode(message), "utf8");
    const sig = r?.signature ?? r;
    return { owner: this.address, message, signature: base58(new Uint8Array(sig)), payload };
  },
};

export const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "");

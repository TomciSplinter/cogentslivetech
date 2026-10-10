// Creates a fresh Solana wallet for a bot.
//   npm run new-wallet
// Paste the SECRET into .env on the server (BOT_ROHM_SECRET_KEY=...), never anywhere else.
import { newWallet } from "../src/solana.ts";

const w = newWallet();
console.log(`
New bot wallet
--------------
Address (public, safe to share, send SOL here):
  ${w.publicKey}

Secret key (PRIVATE, whoever has this owns the money):
  ${w.secret}

Put the secret key in the server's .env file, e.g.
  BOT_ROHM_SECRET_KEY=${w.secret.slice(0, 6)}…
Also save it in your password manager. Never paste it in chats, screenshots or GitHub.
`);

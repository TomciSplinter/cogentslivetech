// Emergency tool: prints a user bot's wallet secret so you can import it into
// Phantom/Solflare (e.g. to rescue SOL someone sent to an archived bot).
//   npm run export-key -- <bot handle> --yes-i-understand
import { config } from "../src/config.ts";
import { decryptSecret } from "../src/secrets.ts";
import { SupabaseStore } from "../src/store.ts";
import { walletFromSecret } from "../src/solana.ts";

const [id, flag] = process.argv.slice(2);
if (!id || flag !== "--yes-i-understand") {
  console.log("Usage: npm run export-key -- <bot handle> --yes-i-understand\nWhoever sees the printed key controls that wallet. Run it only in a private terminal.");
  process.exit(1);
}
if (!config.supabaseUrl || !config.supabaseSecretKey) throw new Error("Supabase settings missing in .env");
const enc = await new SupabaseStore().getBotSecret(id);
if (!enc) {
  console.log(`No wallet key stored for "${id}" (paper bots don't have one).`);
  process.exit(1);
}
const secret = decryptSecret(enc);
console.log(`\nBot ${id}\nAddress: ${walletFromSecret(secret).publicKey}\nSecret:  ${secret}\n\nImport it in Phantom: Add account → Import private key. Then clear this terminal.\n`);

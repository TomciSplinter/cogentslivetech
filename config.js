// Website settings. Everything here is PUBLIC by design (safe to ship in a website).
// Leave SUPABASE_URL empty to run the built-in demo with simulated bots.
window.COGENTS_CONFIG = {
  // Supabase → Project Settings → API: Project URL + Publishable key (sb_publishable_… or old "anon public")
  SUPABASE_URL: "",
  SUPABASE_PUBLISHABLE_KEY: "",
  // Your engine's public address for creating bots, e.g. "https://api.cogents.xyz"
  API_URL: "",
  // Twitch channel name, e.g. "cogentstv" (shows Twitch links on the site)
  TWITCH_CHANNEL: "",
  // Shown in the corner of the Twitch stream, e.g. "cogents.xyz"
  SITE_LABEL: "",
  X_URL: "https://x.com/",
  // $GENTS token address, once it exists. Shows a copyable "CA" chip in the header.
  GENTS_CA: "",
};

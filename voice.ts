// Text-to-speech through ElevenLabs, with a daily character budget.
import { config } from "./config.ts";
import { dayStart, fetchT, log } from "./util.ts";

let day = 0;
let charsToday = 0;

export function voiceEnabled() {
  return !!config.elevenLabsKey;
}

/** Returns MP3 bytes, or undefined if voice is off, over budget, or failed. */
export async function speak(voiceId: string, text: string): Promise<Uint8Array | undefined> {
  if (!config.elevenLabsKey || !voiceId || !text) return undefined;
  const d = dayStart(Date.now());
  if (d !== day) {
    day = d;
    charsToday = 0;
  }
  if (charsToday + text.length > config.maxTtsCharsPerDay) {
    log("voice", "daily character budget reached, text only until tomorrow");
    return undefined;
  }
  try {
    const res = await fetchT(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_64`,
      {
        method: "POST",
        headers: { "xi-api-key": config.elevenLabsKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({
          text,
          model_id: config.elevenLabsModel,
          voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35 },
        }),
      },
      30_000,
    );
    if (!res.ok) {
      log("voice", `ElevenLabs HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return undefined;
    }
    charsToday += text.length;
    return new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    log("voice", "TTS failed:", (e as Error).message);
    return undefined;
  }
}

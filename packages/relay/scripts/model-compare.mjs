/* Compare cheap Gemini models for callout translation: latency + quality. */
const KEY = process.env.GEMINI_API_KEY || "";
if (!KEY) {
  console.error("set GEMINI_API_KEY");
  process.exit(1);
}
const SYS =
  "You translate live voice comms from Valorant from English to Vietnamese. Output ONLY the translation. Keep gaming jargon and map callouts natural (A site, rush B, rotate, eco, clutch, one tapped). Use common Vietnamese gaming slang. Keep proper nouns as-is. Short and spoken-style.";
const TEXT = "One enemy A site, watching the angle. Enemy down mid, rotate now. Clutch time, two left.";

const MODELS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["gemini-2.5-flash", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-flash-lite-latest"];

const body = (model) =>
  JSON.stringify({
    systemInstruction: { parts: [{ text: SYS }] },
    contents: [{ role: "user", parts: [{ text: TEXT }] }],
    generationConfig: { temperature: 0.15, maxOutputTokens: 120, thinkingConfig: { thinkingBudget: 0 } },
  });

for (const model of MODELS) {
  const t0 = Date.now();
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-goog-api-key": KEY },
      body: body(model),
    });
    const ms = Date.now() - t0;
    if (!res.ok) {
      const detail = await res.text();
      const msg = detail.match(/"message":\s*"([^"]+)"/)?.[1] || detail.slice(0, 120);
      console.log(`${model}: HTTP ${res.status} (${ms}ms) — ${msg}`);
      continue;
    }
    const data = await res.json();
    const out = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
    const usage = data.usageMetadata || {};
    console.log(`${model}: ${ms}ms | tokens in=${usage.promptTokenCount} out=${usage.candidatesTokenCount}`);
    console.log(`   VI: ${out}`);
  } catch (err) {
    console.log(`${model}: FAIL ${err.message}`);
  }
}

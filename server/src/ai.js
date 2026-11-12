// Optional: let Claude rewrite already-computed summaries in friendlier words.
// OFF by default (free pilot). Turn on in .env:
//   AI_PROVIDER=claude
//   ANTHROPIC_API_KEY=...            (or log in with the `ant` CLI)
//   AI_MODEL=claude-opus-5-5         (default; claude-haiku-5-5 is much cheaper)
// Rules: Claude only gets the summary lines (numbers and subject names, no student names),
// it must not add facts, and if anything goes wrong the plain template text is used.
const crypto = require("crypto");

const PROVIDER = process.env.AI_PROVIDER || "none";
const MODEL = process.env.AI_MODEL || "claude-opus-5-5";
// models that support the server-side refusal fallback
const FALLBACK_MODELS = ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-fable-5-2"];
const CACHE_HOURS = 24;

let client = null;
const cache = new Map();

function enabled() {
    return PROVIDER === "claude";
}

function getClient() {
    if (!client) {
        const sdk = require("@anthropic-ai/sdk");
        const Anthropic = sdk.default || sdk;
        client = new Anthropic({ timeout: 20000, maxRetries: 1 });
    }
    return client;
}

// lines: the template sentences. audience: "student" or "faculty". Returns { text, by }.
async function rewrite(lines, audience) {
    const fallback = { text: lines.join(" "), by: "rules" };
    if (!enabled() || !lines.length) return fallback;

    const key = crypto.createHash("sha256").update(audience + "\n" + lines.join("\n")).digest("hex");
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return hit.value;

    try {
        const request = {
            model: MODEL,
            max_tokens: 1024,
            output_config: { effort: "low" },
            system:
                "You rewrite short academic progress notes for a college app. Use ONLY the facts given: do not add, " +
                "change or guess any number, name, subject or advice. Write 2-4 short, kind, plain-English sentences " +
                (audience === "student"
                    ? "speaking to the student as 'you'. Be encouraging, never alarming."
                    : "for a teacher. Be factual and brief.") +
                " Reply with the rewritten text only.",
            messages: [{ role: "user", content: lines.join("\n") }],
        };
        if (FALLBACK_MODELS.includes(MODEL)) {
            request.betas = ["server-side-fallback-2026-07-01"];
            request.fallbacks = "default";
        }
        const response = await getClient().beta.messages.create(request);
        if (response.stop_reason === "refusal") return fallback;
        const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
        if (!text) return fallback;

        const value = { text, by: "ai" };
        cache.set(key, { value, until: Date.now() + CACHE_HOURS * 3600000 });
        return value;
    } catch (err) {
        console.error("AI rewrite failed, using the plain summary:", err.message);
        return fallback;
    }
}

module.exports = { enabled, rewrite, MODEL };

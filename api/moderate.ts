import Ajv from "ajv";
import addFormats from "ajv-formats";

type ItemType = "chat" | "video_title" | "video_caption" | "video_frame_auto";
interface ItemPayload { type: ItemType; text: string; }

const VerdictSchema = {
  type: "object",
  required: ["verdict", "policy_tags", "rationale", "safe_suggestion"],
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["allow", "soft_block", "block"] },
    policy_tags: {
      type: "array",
      items: { type: "string", enum: ["bullying","hate","sexual","self_harm","violence","pii","profanity","illegal","spam","theology"] },
      uniqueItems: true
    },
    rationale: { type: "string", maxLength: 280 },
    safe_suggestion: { type: ["string","null"], maxLength: 500 }
  }
} as const;

const ajv = new Ajv({ allErrors:true, strict:true });
addFormats(ajv);
const validate = ajv.compile(VerdictSchema);

// --- Fast regex prechecks (no LLM) ---
const PII = [
  /\b\d{2,4}\s+[A-Za-z0-9 .'-]+(Street|St|Road|Rd|Ave|Avenue|Blvd|Lane|Ln)\b/i,
  /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{3,4}\b/,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
];
const RX = {
  sexual: /\b(onlyfans|nude|nudes|send pics|sext|hookup|explicit)\b/i,
  violence: /\b(kill|stab|shoot|knock.*out|bomb|beat.*up)\b/i,
  hate: /\b(terrorist|nazi|white power|go back to|racial slur)\b/i,
  selfharm: /\b(kill myself|suicide|self-harm|cutting)\b/i,
  bully: /\b(stupid|dumb|loser|idiot|kill yourself|kys)\b/i,
  profanity: /\b(fuck|shit|bitch|asshole|slut|dick|cunt)\b/i,
  illegal: /\b(drugs for sale|buy weed|fake id|steal|shoplift)\b/i
};

function precheck(item: ItemPayload) {
  const t = item.text || "";
  const tl = t.toLowerCase();
  if (PII.some(rx=>rx.test(t))) return { verdict:"block", policy_tags:["pii"], rationale:"PII detected.", safe_suggestion:null };
  if (RX.sexual.test(tl)) return { verdict:"block", policy_tags:["sexual"], rationale:"Sexual/explicit.", safe_suggestion:null };
  if (RX.violence.test(tl)) return { verdict:"block", policy_tags:["violence"], rationale:"Violence.", safe_suggestion:null };
  if (RX.hate.test(tl)) return { verdict:"block", policy_tags:["hate"], rationale:"Hate/extremism.", safe_suggestion:null };
  if (RX.illegal.test(tl)) return { verdict:"block", policy_tags:["illegal"], rationale:"Illegal activity.", safe_suggestion:null };
  if (RX.selfharm.test(tl)) return { verdict:"soft_block", policy_tags:["self_harm"], rationale:"Self-harm tone.", safe_suggestion:"I’m sorry you’re hurting. Would you like to talk to a trusted adult or get help?" };
  if (RX.bully.test(tl)) return { verdict:"soft_block", policy_tags:["bullying"], rationale:"Unkind/insulting.", safe_suggestion:"Try a kinder version, e.g., “That was tough—want help practicing?”" };
  if (RX.profanity.test(tl)) return { verdict:"soft_block", policy_tags:["profanity"], rationale:"Profanity.", safe_suggestion:"Please rephrase without profanity." };
  return null;
}

function buildPrompt(type: string, text: string) {
  const safe = text.replaceAll('"','\\"').slice(0,8000);
  return `You enforce a faith-guided, youth-safe chat/video policy. Review the ITEM below.
Return strict JSON only — no prose, no code fences.

CONSTITUTION:
- Love, respect, humility, honesty; no bullying or insults.
- Purity and safety; no sexualized or grooming content.
- Peacemaking; no threats or glorification of violence.
- No hate, discrimination, or extremism.
- Protect privacy; no PII exchange.
- No self-harm encouragement; surface supportive language.

OUTPUT SCHEMA:
{
  "verdict": "allow" | "soft_block" | "block",
  "policy_tags": [ "bullying" | "hate" | "sexual" | "self_harm" | "violence" | "pii" | "profanity" | "illegal" | "spam" | "theology" ],
  "rationale": "short string for moderators",
  "safe_suggestion": "string or null"
}

ITEM:
type: "${type}"
text: "${safe}"`;
}

function sanitizeToJSON(s: string) {
  const t = s.trim();
  const si = Math.min(...["{","["].map(ch => t.indexOf(ch) === -1 ? 1e12 : t.indexOf(ch)));
  const ei = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  return (si >= 1e12 || ei === -1) ? t : t.slice(si, ei+1);
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization"
    }});
  }
  if (req.method !== "POST") {
    return new Response("Use POST", { status: 405, headers: { "Access-Control-Allow-Origin": "*" } });
  }

  let item: ItemPayload;
  try { item = await req.json() as ItemPayload; }
  catch { return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: { "Content-Type":"application/json","Access-Control-Allow-Origin":"*" } }); }

  if (!item?.type || typeof item.text !== "string") {
    return new Response(JSON.stringify({ error: "Expected {type, text}" }), { status: 400, headers: { "Content-Type":"application/json","Access-Control-Allow-Origin":"*" } });
  }

  const quick = precheck(item);
  if (quick) return new Response(JSON.stringify(quick), { headers: { "Content-Type":"application/json","Access-Control-Allow-Origin":"*" } });

  const provider = process.env.PROVIDER || "openai";
  const prompt = buildPrompt(item.type, item.text);

  let raw = "";
  if (provider === "groq") {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.GROQ_MODEL || "llama-3.1-8b-instant", messages: [{ role: "system", content: prompt }], temperature: 0 })
    });
    const j = await r.json();
    raw = j.choices?.[0]?.message?.content ?? "";
  } else {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || "gpt-4o-mini", messages: [{ role: "system", content: prompt }], temperature: 0 })
    });
    const j = await r.json();
    raw = j.choices?.[0]?.message?.content ?? "";
  }

  let parsed: any;
  try { parsed = JSON.parse(sanitizeToJSON(raw)); }
  catch {
    return new Response(JSON.stringify({ error: "LLM did not return valid JSON", raw }), { status: 502, headers: { "Content-Type":"application/json","Access-Control-Allow-Origin":"*" } });
  }
  if (!validate(parsed)) {
    return new Response(JSON.stringify({ error: "JSON failed schema", raw: parsed }), { status: 500, headers: { "Content-Type":"application/json","Access-Control-Allow-Origin":"*" } });
  }

  return new Response(JSON.stringify(parsed), { headers: { "Content-Type":"application/json","Access-Control-Allow-Origin":"*" } });
}

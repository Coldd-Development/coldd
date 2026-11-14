// supabase/functions/_shared/copy.ts
//
// Cleans marketplace copy before it becomes a coldd product description:
//   cleanBullets  plain description text -> "- " bullet list in sentence case
//   cleanSummary  short summary (max 100 characters, the admin editor's limit)
//
// What it fixes: Title Case ("High Quality PBR Textures"), capitals after commas, lowercase proper
// nouns, a few common typos ("Fan's", "a outdoor", "Non-Furnished"), hyphenation ("two-story"),
// trailing full stops on bullets, "Game ready - drop & drag" style joins and "& More!".
// Words that keep their capitals: acronyms, anything with a digit, proper nouns in PROPER, and
// the distinctive words of the product's own title (brand names such as "Pizza Hut").
// Pure functions, no Deno APIs.

export const SUMMARY_MAX = 100;

const PROPER = ["Indonesian", "Indonesia", "Jakarta", "Bekasi", "Torajan", "Roman", "European", "American", "British", "Japanese", "Roblox", "USA", "UK", "Russia"];
const PROPER_SET = new Set(PROPER.map((p) => p.toLowerCase()));
const ACRONYMS: Record<string, string> = { tv: "TV", ac: "AC", atm: "ATM", rp: "RP", csg: "CSG", fob: "FOB", pbr: "PBR", vfx: "VFX", rng: "RNG", uk: "UK", usa: "USA", cia: "CIA", hq: "HQ" };

// Ordinary words that appear in product titles; they must NOT be protected from lowercasing.
const GENERIC = new Set(("building buildings house houses home homes store shop shophouse shophouses pack packs kit kits restaurant cafe hospital station office school mosque market supermarket " +
  "dealership apartment apartments flats flat villa mansion dormitory dorm tower fort bank motel hotel stadium center centre mall garage warehouse bunker outpost filler modern luxury small large " +
  "big low poly high quality double story stories two three asset assets collection bundle set game ready military police fire department sheriff county national park service post car wash " +
  "repair auto fast food clothing street streetside side industrial storage unit abandoned aesthetic cluster construction connected multi wooden loft beach cabin cottage facility armory " +
  "cafeteria laboratory vehicle gear room basement underground sci-fi colony luxury realistic detailed furnished interior exterior mobile bus sports pickaxe fishing rod aura " +
  "shopping convenience minimarket mart grocery hypermarket super supercenter plaza complex hall theatre theater museum church temple library clinic pharmacy bakery diner pub bar gym salon " +
  "hangar hanger factory plant depot terminal airport port dock harbor lighthouse castle palace ranch farm barn lodge resort inn tavern arena court gate checkpoint cave tent camp").split(/\s+/));

function protectedTitleWords(title: string): Set<string> {
  const out = new Set<string>();
  for (const w of title.split(/[^A-Za-z0-9'-]+/)) {
    if (w.length >= 3 && /^[A-Z]/.test(w) && !GENERIC.has(w.toLowerCase())) out.add(w.toLowerCase());
  }
  return out;
}

const keepsCaps = (c: string, prot: Set<string>) =>
  /^[A-Z0-9]{2,}$/.test(c) || /\d/.test(c) || /[a-z][A-Z]/.test(c) || PROPER_SET.has(c.toLowerCase()) || prot.has(c.toLowerCase());

function fixWord(token: string, isFirst: boolean, prot: Set<string>): string {
  const m = /^([^A-Za-z0-9]*)([A-Za-z0-9'\-]+)(.*)$/.exec(token);
  if (!m) return token;
  const [, pre, body, post] = m;
  if (body === "A" && !isFirst) return pre + "a" + post;
  const parts = body.split("-").map((p, i) => {
    if (ACRONYMS[p.toLowerCase()]) return ACRONYMS[p.toLowerCase()];
    if (PROPER_SET.has(p.toLowerCase())) return PROPER.find((x) => x.toLowerCase() === p.toLowerCase())!;
    if (keepsCaps(p, prot)) return p;
    if (i === 0 && isFirst) return p.charAt(0).toUpperCase() + p.slice(1);
    return /^[A-Z][a-z]/.test(p) ? p.toLowerCase() : p;
  });
  return pre + parts.join("-") + post;
}

function sentenceCase(line: string, prot: Set<string>): string {
  let first = true;
  return line.split(/(\s+)/).map((tok) => {
    if (/^\s*$/.test(tok) || tok === "&") return tok;
    if (!/[A-Za-z]/.test(tok)) { if (/\d/.test(tok)) first = false; return tok; } // "6 clothing stands": a leading number counts as the first word
    const out = fixWord(tok, first, prot);
    first = /[.!?]["')\]]*$/.test(tok);
    return out;
  }).join("");
}

function normalizeText(t: string): string {
  return t
    .replace(/\b[Aa] outdoor plants\b/g, "outdoor plants")
    .replace(/\b(?:Un|Non|Semi)-?\s?[Ff]urnished\b/g, (m) => (/^semi/i.test(m) ? "semi-furnished" : "unfurnished"))
    .replace(/\bTV's\b/g, "TVs").replace(/\bID's\b/g, "IDs").replace(/\bFan's\b/g, "fans").replace(/\bLogo's\b/g, "logos")
    .replace(/\b([Aa]) (outdoor|indoor|interior|exterior|outer)\b/gi, (_m, a, w) => (a === "A" ? "An " : "an ") + w)
    .replace(/\b(two|three|double|2|3) story\b/gi, (_m, n) => n + "-story")
    .replace(/\b(two|three) floor building\b/gi, (_m, n) => n + "-floor building")
    .replace(/\bmulti story\b/gi, "multi-story")
    .replace(/\bclass rooms\b/gi, "classrooms").replace(/\bw\//g, "with")
    .replace(/\bbulding\b/gi, "building").replace(/\brun ?down\b/gi, "run-down").replace(/\broleplays\b/gi, "roleplay")
    .replace(/\bNote: interior is not furnished/i, "Note: the interior is not furnished");
}
const finish = (t: string) => t.replace(/\bro-nations\b/gi, "Ro-Nations").replace(/\s+/g, " ").trim();

// Lines that are names, not sentences: model/variant names and "Label: Name, Name, Name" lists.
const isNameLine = (t: string) => /^\S+ Type [A-Z0-9]{1,3}\b/.test(t) || /:\s*[A-Z][a-z]+(?:,\s*[A-Z][a-z]+){2,}/.test(t);

function cleanBulletLine(text: string, prot: Set<string>): string[] {
  const whole = text.trim();
  if (/^\S+ Type [A-Z0-9]{1,3}\b/.test(whole)) return [whole];
  if (isNameLine(whole)) { // "Special Designs: Divine, Galaxy": clean the label, keep the names
    const i = whole.indexOf(":");
    return [finish(sentenceCase(normalizeText(whole.slice(0, i)), prot)) + whole.slice(i)];
  }
  if (/^(?:&|and)\s*more!?$/i.test(whole)) return ["And more!"];
  if (/^game ready\s*-\s*(?:drop & drag|drag & drop)$/i.test(whole)) return ["Game ready", "Drag & drop"];
  if (/^drop & drag$/i.test(whole)) return ["Drag & drop"];
  if (/^optimize$/i.test(whole)) return ["Optimized"];
  if (/^low part$/i.test(whole)) return ["Low part count"];
  return [finish(sentenceCase(normalizeText(whole), prot)).replace(/\.$/, "")];
}

/** Plain description text (one line per point) -> "- " bullet list. */
export function cleanBullets(text: string, title = ""): string {
  const prot = protectedTitleWords(title);
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const l = raw.replace(/^[\s•\-*▪►➤✓✔✅>]+/u, "").trim();
    if (l.length < 2) continue;
    if (/^(product |key |main )?(features?|includes?|included|details|description|specs?|specifications|what'?s included|contents)\s*:?$/i.test(l)) continue;
    if (/:\s*$/.test(l) && l.length < 40) continue;
    if (/https?:\/\/|discord\.gg|show ?case\s*>>/i.test(l)) continue;
    for (const nb of cleanBulletLine(l.slice(0, 300), prot)) {
      // a paragraph of several sentences becomes one bullet per sentence
      for (const piece of nb.split(/(?<=[.!?])\s+(?=[A-Z])/)) {
        const b = "- " + piece.replace(/\.$/, "");
        if (b.length > 2 && !out.includes(b)) out.push(b);
      }
    }
  }
  return out.join("\n").slice(0, 8000);
}

function fitSummary(s: string): string {
  s = s.trim();
  if (s.length <= SUMMARY_MAX) return s;
  const cut = s.slice(0, SUMMARY_MAX);
  const comma = cut.lastIndexOf(", ");
  const base = comma >= 40 ? cut.slice(0, comma) : cut.slice(0, cut.lastIndexOf(" "));
  return base.replace(/[\s,;:&-]+$/, "");
}

/**
 * Short summary, at most 100 characters. A marketplace tagline is kept (cleaned); with no tagline the
 * first bullets are joined as "Detailed interior, high quality assets, ..." (lowercase after commas).
 */
export function cleanSummary(summary: string, bullets: string, title = ""): string {
  const prot = protectedTitleWords(title);
  let s = String(summary ?? "").trim().replace(/^["“”']+|["“”']+$/g, "").trim();
  if (s) {
    s = finish(normalizeText(s));
    const words = s.split(/\s+/).map((w) => w.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "")).filter((w) => /^[A-Za-z]{3,}$/.test(w) && !SMALL.has(w.toLowerCase()));
    const titleish = words.length >= 3 && words.filter((w) => /^[A-Z][a-z]/.test(w)).length / words.length >= 0.6;
    if (titleish && !/:/.test(s)) s = finish(sentenceCase(s, prot));
    s = s.replace(/\b([A-Za-z]+)\b/g, (w) => (PROPER_SET.has(w.toLowerCase()) ? PROPER.find((x) => x.toLowerCase() === w.toLowerCase())! : w));
    return fitSummary(s.replace(/^([^A-Za-z]*)([a-z])/, (_m, p, c) => p + c.toUpperCase()));
  }
  const parts = bullets.split("\n").map((b) => b.replace(/^- /, "").trim()).filter(Boolean);
  let out = "";
  for (const p of parts) {
    const seg = out ? p.replace(/^([A-Za-z])(\S*)/, (m, a, rest) => (keepsCaps(a + rest, prot) || /^[A-Z]{2,}/.test(m) ? m : a.toLowerCase() + rest)) : p;
    const next = out ? out + ", " + seg : seg;
    if (next.length > SUMMARY_MAX) break;
    out = next;
    if (out.split(", ").length >= 3) break;
  }
  return fitSummary(out || title);
}

const SMALL = new Set(["a", "an", "the", "and", "or", "of", "for", "with", "to", "in", "on", "at", "by", "as", "is", "are", "from", "your", "into"]);

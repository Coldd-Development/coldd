// supabase/functions/admin-ai-autofill/index.ts
//
// Deploy with:
//   supabase functions deploy admin-ai-autofill
//
// Required secret (set once, never committed):
//   supabase secrets set ANTHROPIC_API_KEY=<key from console.anthropic.com>
//
// Powers the "Auto-fill with AI" button on the admin product form: given the
// thumbnail, the uploaded file's name and whatever the admin already typed, it
// drafts the title, catalog subtext, product-page description, category and
// subcategory. The admin always reviews and edits the result; the client only
// fills fields that are still empty.
//
// The rules below are enforced twice: in the prompt, and again in code after
// the model answers (length caps, dash stripping, category/subcategory must be
// real options), so a bad completion can never put an invalid value in the form.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = "https://coldd.dev";
const MODEL = "claude-sonnet-5-5";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

const RULES = `You write storefront copy for coldd Development, a marketplace of Roblox game templates, maps, systems, UI kits and VFX for developers.

Hard rules:
- Use only what is evident from the inputs (thumbnail, file name, the admin's own title/notes, platform, price). Never invent feature counts, compatibility claims, performance claims, version numbers, awards or sales figures. If something is unknown, stay general.
- No hype words (ultimate, best, amazing, perfect, revolutionary, game-changing) and no emoji.
- Never use em dashes or en dashes. Use commas or full stops instead.
- British spelling (licence, colour, customise).
- title: the product name only, Title Case, 60 characters or fewer, no version numbers, no quotes, no trailing punctuation. If the admin already typed a title, keep it as is.
- subtext: one plain sentence, 120 characters or fewer, saying what the buyer gets. Shown on catalog cards.
- description: 2 or 3 short paragraphs separated by a blank line, 600 characters or fewer in total, plain text with no markdown or bullet characters. Say what it is, what is in it, and who it suits.
- category must be exactly one of the allowed categories. subcategory must be exactly one of that category's allowed subcategories, or an empty string if the category has none or none fit.`;

function clean(s: unknown, max: number): string {
  return String(s ?? "")
    .replace(/[–—]/g, ",")
    .replace(/\s+,/g, ",")
    .replace(/[ \t]+/g, " ")
    .replace(/\r/g, "")
    .trim()
    .slice(0, max);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    // Admin only.
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ ok: false, error: "Please sign in." }, 401);
    const { data: profile, error: profileErr } = await admin
      .from("profiles").select("is_admin").eq("id", userData.user.id).single();
    if (profileErr || !profile?.is_admin) return json({ ok: false, error: "Admin access required." }, 403);

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY") || "";
    if (!apiKey) {
      return json({
        ok: false,
        notConfigured: true,
        error: "AI autofill is not set up yet. Set the ANTHROPIC_API_KEY secret in Supabase to enable it.",
      }, 503);
    }

    const body = await req.json().catch(() => ({}));
    const categories: string[] = Array.isArray(body.categories) ? body.categories.map(String).slice(0, 40) : [];
    const subcats: Record<string, string[]> = {};
    if (body.subcats && typeof body.subcats === "object") {
      for (const [cat, list] of Object.entries(body.subcats as Record<string, unknown>)) {
        if (Array.isArray(list)) subcats[cat] = list.map(String).slice(0, 60);
      }
    }
    if (!categories.length) return json({ ok: false, error: "No categories supplied." }, 400);

    const titleHint = clean(body.titleHint, 120);
    const notes = clean(body.notes, 600);
    const fileName = clean(body.fileName, 200);
    const platform = clean(body.platform, 40) || "Roblox";
    const price = Number(body.priceUsd) > 0 ? `$${Number(body.priceUsd).toFixed(2)}` : "not set";
    const thumb = typeof body.thumbnailUrl === "string" && /^https:\/\//.test(body.thumbnailUrl) ? body.thumbnailUrl : "";

    const catList = categories.map((c) => `- ${c}${subcats[c]?.length ? `: ${subcats[c].join(" | ")}` : " (no subcategories)"}`).join("\n");
    const text = [
      `Platform: ${platform}`,
      `Price (USD): ${price}`,
      `Admin-typed title: ${titleHint || "(none)"}`,
      `Uploaded file name: ${fileName || "(none)"}`,
      `Admin notes: ${notes || "(none)"}`,
      "",
      "Allowed categories and their subcategories:",
      catList,
      "",
      thumb ? "The product thumbnail is attached." : "No thumbnail is available.",
    ].join("\n");

    const content: unknown[] = [];
    if (thumb) content.push({ type: "image", source: { type: "url", url: thumb } });
    content.push({ type: "text", text });

    const subcatEnum = Array.from(new Set(Object.values(subcats).flat().concat([""])));
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1200,
        system: RULES,
        tools: [{
          name: "fill_product",
          description: "Return the drafted storefront fields for this product.",
          input_schema: {
            type: "object",
            properties: {
              title: { type: "string" },
              subtext: { type: "string" },
              description: { type: "string" },
              category: { type: "string", enum: categories },
              subcategory: { type: "string", enum: subcatEnum },
            },
            required: ["title", "subtext", "description", "category", "subcategory"],
          },
        }],
        tool_choice: { type: "tool", name: "fill_product" },
        messages: [{ role: "user", content }],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("anthropic error", res.status, detail.slice(0, 300));
      return json({ ok: false, error: "The AI service could not draft this right now. Try again, or fill the fields by hand." }, 502);
    }
    const data = await res.json();
    // deno-lint-ignore no-explicit-any
    const block = (data.content || []).find((b: any) => b.type === "tool_use");
    const out = block?.input;
    if (!out) return json({ ok: false, error: "The AI returned nothing usable. Try again." }, 502);

    // Re-enforce the rules in code.
    const category = categories.includes(out.category) ? out.category : "";
    const allowedSubs = subcats[category] || [];
    const subcategory = allowedSubs.includes(out.subcategory) ? out.subcategory : "";
    const title = titleHint || clean(out.title, 60);
    return json({
      ok: true,
      fields: {
        title,
        subtext: clean(out.subtext, 120),
        description: clean(out.description, 600),
        category,
        subcategory,
      },
    });
  } catch (e) {
    console.error("admin-ai-autofill", e);
    return json({ ok: false, error: "Something went wrong drafting this product." }, 500);
  }
});

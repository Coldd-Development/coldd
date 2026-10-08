// supabase/functions/admin-generate-legal-docx/index.ts
//
// Deploy with:
//   supabase functions deploy admin-generate-legal-docx
//
// Same auth/is_admin gate as the other admin-* functions. Bundles a
// product's entire legal record (proof-of-license, proof-of-development,
// TOS text, contacts, cost, purchase date, resale terms) into a single
// .docx, so a DMCA claim (incoming or outgoing) or any other legal request
// has one document to hand over instead of someone reconstructing it from
// the admin panel's product-edit form under time pressure.
//
// Body: { productId }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink, BorderStyle } from "https://esm.sh/docx@8.5.0";
import { signPrivateDownload } from "../_shared/download.ts";

const ALLOWED_ORIGIN = "https://coldd.dev";
// Long enough to still be valid by the time someone actually opens the
// document later (that's the entire point of generating it ahead of
// need), unlike the 120s TTL the admin panel's own live-browsing links use.
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7;

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

type ProofFile = { name?: string; path?: string };
type Contact = { label?: string; value?: string };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ ok: false, error: "Please sign in." }, 401);

    const admin = createClient(supabaseUrl, serviceKey);

    const { data: profile, error: profileErr } = await admin
      .from("profiles")
      .select("is_admin")
      .eq("id", userData.user.id)
      .single();
    if (profileErr || !profile?.is_admin) return json({ ok: false, error: "Admin access required." }, 403);

    const body = await req.json().catch(() => ({}));
    const productId = String(body.productId || "");
    if (!productId) return json({ ok: false, error: "Missing product." }, 400);

    const { data: product, error: productErr } = await admin
      .from("products")
      .select("title, slug, platform, created_at")
      .eq("id", productId)
      .single();
    if (productErr || !product) return json({ ok: false, error: "Product not found." }, 404);

    const { data: legal } = await admin
      .from("product_legal")
      .select("*")
      .eq("product_id", productId)
      .maybeSingle();

    async function signLegalFile(f: ProofFile): Promise<{ name: string; url: string | null }> {
      const name = f.name || (f.path ? f.path.split("/").pop()! : "file");
      if (!f.path) return { name, url: null };
      return { name, url: await signPrivateDownload(admin, f.path, name, SIGNED_URL_TTL_SECONDS) };
    }

    const proofFiles: ProofFile[] = Array.isArray(legal?.proof_files) ? legal.proof_files : [];
    const devProofFiles: ProofFile[] = Array.isArray(legal?.dev_proof_files) ? legal.dev_proof_files : [];
    const contacts: Contact[] = Array.isArray(legal?.contacts) ? legal.contacts : [];

    const [signedProof, signedDevProof] = await Promise.all([
      Promise.all(proofFiles.map(signLegalFile)),
      Promise.all(devProofFiles.map(signLegalFile)),
    ]);

    function heading(text: string) {
      return new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 300, after: 120 } });
    }
    function field(label: string, value: string) {
      return new Paragraph({
        spacing: { after: 60 },
        children: [
          new TextRun({ text: label + ": ", bold: true }),
          new TextRun({ text: value || " - " }),
        ],
      });
    }
    function fileLinks(title: string, files: { name: string; url: string | null }[]) {
      const out: Paragraph[] = [new Paragraph({ text: title, spacing: { before: 160, after: 60 }, children: [new TextRun({ text: title, bold: true })] })];
      if (!files.length) {
        out.push(new Paragraph({ text: "None on file.", spacing: { after: 60 } }));
        return out;
      }
      files.forEach((f) => {
        out.push(
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 40 },
            children: f.url
              ? [new ExternalHyperlink({ link: f.url, children: [new TextRun({ text: f.name, style: "Hyperlink" })] })]
              : [new TextRun({ text: f.name + " (file missing from storage)" })],
          }),
        );
      });
      return out;
    }

    const generatedAt = new Date();
    const doc = new Document({
      sections: [
        {
          properties: {},
          children: [
            new Paragraph({ text: "coldd Development", heading: HeadingLevel.TITLE }),
            new Paragraph({ text: "Product Legal Record", heading: HeadingLevel.HEADING_1, spacing: { after: 60 } }),
            new Paragraph({
              spacing: { after: 200 },
              border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999" } },
              children: [new TextRun({ text: `Generated ${generatedAt.toISOString()} for legal/DMCA reference. File links below are valid for 7 days from generation.`, italics: true, color: "666666" })],
            }),

            heading("Product"),
            field("Title", product.title),
            field("Slug", product.slug),
            field("Platform", product.platform),
            field("Listed since", product.created_at ? new Date(product.created_at).toISOString().slice(0, 10) : " - "),

            heading("Licensing terms (as sold to customers)"),
            new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: legal?.tos || "No terms of sale text on file." })] }),

            heading("How coldd acquired the right to sell this"),
            field("License types", (Array.isArray(legal?.license_types) ? legal.license_types : []).map((t: string) => (({ ownership: "Ownership", resell_plus: "Resell+ (sell, and sell resell licenses)", resell_rights: "Resell Rights (sell only)", revenue_share: "Revenue Share" } as Record<string, string>)[t] || t)).join(", ") || " - "),
            ...((Array.isArray(legal?.license_types) ? legal.license_types : []).includes("revenue_share") ? [
              field("Revenue share owed to the owner", legal?.revenue_share_pct != null ? `${legal.revenue_share_pct}% of sales` : " - "),
              field("Payment platform", legal?.revenue_share_payment_platform || " - "),
              field("Payment link", legal?.revenue_share_payment_link || " - "),
            ] : []),
            field("Cost", legal?.license_cost != null ? `${legal.license_cost} ${(legal?.license_cost_currency || "usd").toUpperCase()}` : " - "),
            field("Purchased on", legal?.license_purchased_at || " - "),
            field("Can be offered for free", legal?.can_be_free ? "Yes" : "No"),
            field("Resale by coldd disallowed", legal?.disallow_sales ? "Yes" : "No"),
            field("Minimum resale price (USD)", legal?.min_sale_usd != null ? String(legal.min_sale_usd) : " - "),
            field("Minimum resale price (Robux)", legal?.min_sale_robux != null ? String(legal.min_sale_robux) : " - "),
            field("Maximum discount allowed", legal?.max_discount_pct ? `${legal.max_discount_pct}%` : "No cap"),

            heading("Contacts on record"),
            ...(contacts.length
              ? contacts.filter((c) => c.label || c.value).map((c) => field(c.label || "Contact", c.value || " - "))
              : [new Paragraph({ text: "None on file." })]),

            ...fileLinks("Proof of license (right to sell)", signedProof),
            ...fileLinks("Proof of development (original creation)", signedDevProof),
          ],
        },
      ],
    });

    const buf = await Packer.toBuffer(doc);
    const filename = `${product.slug}-legal-record.docx`;

    return new Response(buf, {
      status: 200,
      headers: {
        ...corsHeaders(),
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error("[admin-generate-legal-docx] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});

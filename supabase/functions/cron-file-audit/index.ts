// supabase/functions/cron-file-audit/index.ts
//
// Deploy with:
//   supabase functions deploy cron-file-audit --no-verify-jwt
// Scheduled daily by supabase/file_audit_cron.sql (x-cron-secret = FILE_AUDIT_CRON_SECRET).
//
// The daily stored-file check. Checks every file a product, add-on or legal entry points at
// (see _shared/files.ts). A legal entry that lost its path is re-linked automatically when
// the upload ledger has its file; anything still wrong is sent to every admin as a bell
// notification, so a broken download is noticed the same day instead of by a customer.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { auditStoredFiles, relinkLegalFile } from "../_shared/files.ts";
import { notifyUser } from "../_shared/notify.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  try {
    const cronSecret = Deno.env.get("FILE_AUDIT_CRON_SECRET");
    if (!cronSecret || req.headers.get("x-cron-secret") !== cronSecret) {
      return json({ ok: false, error: "Unauthorized." }, 401);
    }
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { checked, problems } = await auditStoredFiles(admin);

    const relinked: string[] = [];
    for (const p of problems.filter((x) => x.recoverable && x.kind.startsWith("proof"))) {
      if (await relinkLegalFile(admin, p.productId, p.name, p.recoverable!)) relinked.push(`${p.slug}: ${p.name}`);
    }
    const left = problems.filter((p) => !(p.recoverable && p.kind.startsWith("proof")));

    if (left.length || relinked.length) {
      const lines = [
        ...left.slice(0, 15).map((p) => `${p.slug}: ${p.kind} "${p.name}" - ${p.problem}`),
        ...(left.length > 15 ? [`...and ${left.length - 15} more`] : []),
        ...(relinked.length ? [`Re-linked automatically: ${relinked.join("; ")}`] : []),
      ];
      const title = left.length
        ? `File check: ${left.length} product file${left.length === 1 ? "" : "s"} need${left.length === 1 ? "s" : ""} attention`
        : `File check: ${relinked.length} lost file${relinked.length === 1 ? " was" : "s were"} re-linked`;
      const { data: admins } = await admin.from("profiles").select("id").eq("is_admin", true);
      for (const a of admins ?? []) await notifyUser(admin, a.id, title, lines.join("\n"), "/admin/products");
    }

    console.log(`[cron-file-audit] checked ${checked}, problems ${left.length}, relinked ${relinked.length}`);
    return json({ ok: true, checked, problems: left, relinked });
  } catch (err) {
    console.error("[cron-file-audit] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});

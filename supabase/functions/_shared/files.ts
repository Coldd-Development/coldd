// supabase/functions/_shared/files.ts
//
// Guardrails that keep products from pointing at files that aren't there:
//   - recordUpload: every upload link minted is written to storage_uploads (the ledger), so
//     a file's real path is on record even if the product meant to hold it is never saved.
//   - storedFileExists: asks storage for the first byte of a file.
//   - auditStoredFiles: checks every file a product, add-on or legal entry points at, and for
//     entries that lost their path, finds the stored file in the ledger when it can.

// deno-lint-ignore-file no-explicit-any
import { signPrivateDownload } from "./download.ts";

const PLACEHOLDER = "_shared/placeholder.zip";

export async function recordUpload(
  admin: any,
  row: { storedPath: string; kind: string; productSlug: string | null; originalName: string; uploadedBy: string | null },
) {
  const { error } = await admin.from("storage_uploads").upsert({
    stored_path: row.storedPath,
    kind: row.kind,
    product_slug: row.productSlug,
    original_name: row.originalName.slice(0, 300),
    uploaded_by: row.uploadedBy,
  }, { onConflict: "stored_path" });
  if (error) console.error("[files] could not record upload:", error.message);
}

/** true = the file is there, false = storage says it is missing, null = storage didn't answer. */
export async function storedFileExists(admin: any, path: string): Promise<boolean | null> {
  try {
    const url = await signPrivateDownload(admin, path, undefined, 120);
    if (!url) return null;
    const r = await fetch(url, { headers: { Range: "bytes=0-0" } });
    await r.body?.cancel();
    if (r.status === 200 || r.status === 206) return true;
    // download.php says 404; Supabase Storage answers a missing object with 400.
    if (r.status === 404 || r.status === 400) return false;
    return null;
  } catch {
    return null;
  }
}

export type FileProblem = {
  productId: string;
  slug: string;
  kind: string;
  name: string;
  path: string | null;
  problem: string;
  /** For an entry with no path: a stored file from the ledger with the same original name. */
  recoverable?: string;
};

export async function auditStoredFiles(admin: any): Promise<{ checked: number; problems: FileProblem[] }> {
  const [{ data: prods }, { data: legal }, { data: addons }] = await Promise.all([
    admin.from("products").select("id, slug, storage_path"),
    admin.from("product_legal").select("product_id, proof_files, dev_proof_files"),
    admin.from("product_addons").select("product_id, title, storage_path"),
  ]);
  const slugOf = new Map((prods ?? []).map((p: any) => [p.id, p.slug]));
  type Job = Omit<FileProblem, "problem">;
  const jobs: Job[] = [];
  for (const p of prods ?? []) {
    if (p.storage_path && p.storage_path !== PLACEHOLDER) jobs.push({ productId: p.id, slug: p.slug, kind: "product file", name: p.storage_path, path: p.storage_path });
  }
  for (const a of addons ?? []) {
    if (a.storage_path) jobs.push({ productId: a.product_id, slug: slugOf.get(a.product_id) ?? a.product_id, kind: "add-on", name: a.title, path: a.storage_path });
  }
  for (const l of legal ?? []) {
    for (const [kind, list] of [["proof of license", l.proof_files], ["proof of development", l.dev_proof_files]] as const) {
      for (const f of Array.isArray(list) ? list : []) {
        const path = f && typeof f === "object" ? (f.path || null) : null;
        const name = typeof f === "string" ? f : String(f?.name ?? "");
        jobs.push({ productId: l.product_id, slug: slugOf.get(l.product_id) ?? l.product_id, kind, name, path });
      }
    }
  }

  const problems: FileProblem[] = [];
  const seen = new Map<string, boolean | null>();
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      if (!j.path) { problems.push({ ...j, problem: "no stored path" }); continue; }
      if (!seen.has(j.path)) seen.set(j.path, await storedFileExists(admin, j.path));
      const ok = seen.get(j.path);
      if (ok === false) problems.push({ ...j, problem: "file missing from storage" });
      else if (ok === null) problems.push({ ...j, problem: "storage did not answer" });
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));

  // Entries with no path: look the file up in the ledger by its original name.
  const lost = problems.filter((p) => !p.path && p.name);
  if (lost.length) {
    const { data: ledger } = await admin.from("storage_uploads")
      .select("stored_path, original_name, created_at")
      .in("original_name", [...new Set(lost.map((p) => p.name))])
      .order("created_at", { ascending: false });
    for (const p of lost) {
      for (const row of (ledger ?? []).filter((r: any) => r.original_name === p.name)) {
        if (await storedFileExists(admin, row.stored_path)) { p.recoverable = row.stored_path; break; }
      }
    }
  }
  return { checked: jobs.length, problems };
}

/** Puts a recovered path back on every legal entry of a product that lost it (matched by name). */
export async function relinkLegalFile(admin: any, productId: string, name: string, path: string): Promise<boolean> {
  const { data: l } = await admin.from("product_legal").select("proof_files, dev_proof_files").eq("product_id", productId).maybeSingle();
  if (!l) return false;
  let changed = false;
  const fix = (list: any) => (Array.isArray(list) ? list : []).map((f: any) => {
    const fname = typeof f === "string" ? f : String(f?.name ?? "");
    const fpath = f && typeof f === "object" ? f.path : null;
    if (!fpath && fname === name) { changed = true; return { name: fname, path }; }
    return f;
  });
  const proof_files = fix(l.proof_files), dev_proof_files = fix(l.dev_proof_files);
  if (!changed) return false;
  const { error } = await admin.from("product_legal").update({ proof_files, dev_proof_files, updated_at: new Date().toISOString() }).eq("product_id", productId);
  return !error;
}

// supabase/functions/lock-check/index.ts
//
// Verifies the pre-launch lock-screen password server-side, so the real
// password never ships in client-visible source (unlike the old lock.html,
// which had it in plain JS).
//
// Deploy with:
//   supabase functions deploy lock-check --no-verify-jwt
//
// Required secret (set once):
//   supabase secrets set LOCK_PASSWORD=your-staff-password-here
//
// --no-verify-jwt is intentional: this runs before any session exists,
// there is nothing to verify a JWT against yet.

const ALLOWED_ORIGIN = "https://coldd.dev";
const encoder = new TextEncoder();

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "content-type, apikey, authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

// Plain === short-circuits on the first mismatched byte, so response timing
// leaks how many leading characters of a guess are correct. Hashing both
// sides first makes every comparison operate on the same fixed 32-byte
// length regardless of the guess's length, then the XOR-accumulate loop
// below touches every byte no matter where the first mismatch is, so total
// time no longer depends on how much of the guess was right.
async function timingSafeEqual(a: string, b: string) {
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const bytesA = new Uint8Array(digestA);
  const bytesB = new Uint8Array(digestB);
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) diff |= bytesA[i] ^ bytesB[i];
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });

  try {
    const body = await req.json().catch(() => ({}));
    const guess = typeof body.password === "string" ? body.password.slice(0, 256) : "";
    const correct = Deno.env.get("LOCK_PASSWORD") || "";
    const ok = guess.length > 0 && correct.length > 0 && await timingSafeEqual(guess, correct);
    return json({ ok });
  } catch (err) {
    console.error("[lock-check] error:", err);
    return json({ ok: false }, 500);
  }
});

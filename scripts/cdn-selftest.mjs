// scripts/cdn-selftest.mjs - signed check of the Storage Box link on the hosting account.
// Needs CDN_UPLOAD_SECRET in the environment (or scratchpad/cdn-secret.txt). Prints each step.
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
const S = process.env.CDN_UPLOAD_SECRET || (existsSync("scratchpad/cdn-secret.txt") ? readFileSync("scratchpad/cdn-secret.txt", "utf8").trim() : "");
if (!S) { console.error("no secret"); process.exit(1); }
const UP = process.env.CDN_UPLOAD_URL || "https://cdn.coldd.dev/upload.php";
console.log("ping:", await (await fetch(UP + "?action=ping")).text());
const exp = Math.floor(Date.now() / 1000) + 300, path = "selftest/ping.txt";
const sig = createHmac("sha256", S).update(["v2", "selftest", path, exp, 0, "0", "priv"].join("|")).digest("hex");
const r = await fetch(`${UP}?${new URLSearchParams({ action: "selftest", path, exp, max: 0, ow: "0", vis: "priv", sig })}`, { method: "POST" });
console.log("selftest:", r.status, await r.text());

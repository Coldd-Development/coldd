// supabase/functions/_shared/imap.ts
//
// A small IMAP client (TLS, port 993): only what the mailbox jobs need. Commands are
// sent one at a time; literals ({N} followed by N bytes) are returned as raw bytes.

export class Imap {
  private conn!: Deno.TlsConn;
  private buf = new Uint8Array(0);
  private tagN = 0;
  private enc = new TextEncoder();
  private dec = new TextDecoder("latin1");

  async open(host: string) {
    this.conn = await Deno.connectTls({ hostname: host, port: 993 });
    return await this.readLine(); // greeting
  }
  close() { try { this.conn.close(); } catch (_) { /* already closed */ } }

  private async fill() {
    const chunk = new Uint8Array(65536);
    const n = await this.conn.read(chunk);
    if (n === null) throw new Error("IMAP connection closed");
    const next = new Uint8Array(this.buf.length + n);
    next.set(this.buf); next.set(chunk.subarray(0, n), this.buf.length);
    this.buf = next;
  }
  private async readLine(): Promise<string> {
    for (;;) {
      for (let i = 0; i + 1 < this.buf.length; i++) {
        if (this.buf[i] === 13 && this.buf[i + 1] === 10) {
          const line = this.dec.decode(this.buf.subarray(0, i));
          this.buf = this.buf.slice(i + 2);
          return line;
        }
      }
      await this.fill();
    }
  }
  private async readBytes(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) await this.fill();
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }
  // Sends one command; returns the untagged lines and any literals, throws on NO/BAD
  // (a LOGIN failure never repeats the password in the error).
  async cmd(text: string): Promise<{ lines: string[]; literals: Uint8Array[] }> {
    const tag = "C" + (++this.tagN);
    await this.conn.write(this.enc.encode(`${tag} ${text}\r\n`));
    const lines: string[] = [], literals: Uint8Array[] = [];
    for (;;) {
      let line = await this.readLine();
      let m = line.match(/\{(\d+)\}$/);
      while (m) {
        literals.push(await this.readBytes(Number(m[1])));
        const rest = await this.readLine();
        line += " <literal> " + rest;
        m = rest.match(/\{(\d+)\}$/);
      }
      if (line.startsWith(tag + " ")) {
        if (!/^\S+ OK/i.test(line)) throw new Error(/^LOGIN /i.test(text) ? "LOGIN failed" : line.slice(0, 200));
        return { lines, literals };
      }
      lines.push(line);
    }
  }
}

export const imapQuote = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

// UIDs from "* SEARCH 1 2 3" lines.
export function searchUids(lines: string[]): number[] {
  return lines.filter((l) => /^\* SEARCH/i.test(l))
    .flatMap((l) => l.replace(/^\* SEARCH\s*/i, "").split(/\s+/))
    .map(Number).filter((n) => Number.isFinite(n) && n > 0);
}

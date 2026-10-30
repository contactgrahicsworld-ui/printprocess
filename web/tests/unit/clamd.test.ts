import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clamdScanner, noopScanner } from "@/lib/files/scan";

/** Minimal clamd emulator implementing the real INSTREAM wire protocol, to verify our client end-to-end over TCP. */
let server: net.Server;
let port = 0;
let lastReceived = Buffer.alloc(0);

beforeAll(async () => {
  server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      const cmd = "zINSTREAM\0";
      if (buf.length < cmd.length) return;
      if (buf.subarray(0, cmd.length).toString() !== cmd) { sock.end("UNKNOWN COMMAND\0"); return; }
      let off = cmd.length;
      const chunks: Buffer[] = [];
      while (off + 4 <= buf.length) {
        const len = buf.readUInt32BE(off);
        if (len === 0) {
          lastReceived = Buffer.concat(chunks);
          const infected = lastReceived.includes(Buffer.from("EICAR-STANDARD-ANTIVIRUS-TEST-FILE"));
          sock.end(infected ? "stream: Win.Test.EICAR_HDB-1 FOUND\0" : "stream: OK\0");
          return;
        }
        if (off + 4 + len > buf.length) return;
        chunks.push(buf.subarray(off + 4, off + 4 + len));
        off += 4 + len;
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as net.AddressInfo).port;
});
afterAll(() => server.close());

describe("ClamAV clamd INSTREAM client", () => {
  it("reports CLEAN and streams the full content in chunks", async () => {
    const data = Buffer.alloc(200_000, 7); // > 64 KiB ⇒ multiple chunks
    const r = await clamdScanner("127.0.0.1", port).scan(data);
    expect(r.status).toBe("CLEAN");
    expect(lastReceived.equals(data)).toBe(true);
  });
  it("reports INFECTED on a signature hit", async () => {
    const r = await clamdScanner("127.0.0.1", port).scan(Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"));
    expect(r.status).toBe("INFECTED");
    expect(r.detail).toContain("FOUND");
  });
  it("reports ERROR (fail-closed) when clamd is unreachable", async () => {
    const r = await clamdScanner("127.0.0.1", 1, 2000).scan(Buffer.from("x"));
    expect(r.status).toBe("ERROR");
  });
  it("without CLAMAV_HOST records NOT_SCANNED (never claims a scan)", async () => {
    expect((await noopScanner.scan(new Uint8Array([1]))).status).toBe("NOT_SCANNED");
    expect(noopScanner.enabled).toBe(false);
  });
});

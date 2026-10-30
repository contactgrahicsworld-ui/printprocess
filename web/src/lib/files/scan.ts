import net from "node:net";

export type ScanResult = { status: "CLEAN" | "INFECTED" | "ERROR" | "NOT_SCANNED"; detail: string | null };

export interface Scanner {
  readonly enabled: boolean;
  scan(bytes: Uint8Array): Promise<ScanResult>;
}

/** Used when CLAMAV_HOST is not configured. Records NOT_SCANNED — never claims a file was scanned. */
export const noopScanner: Scanner = {
  enabled: false,
  async scan() {
    return { status: "NOT_SCANNED", detail: "No malware scanner configured (CLAMAV_HOST unset)" };
  },
};

/** ClamAV clamd INSTREAM over TCP (zINSTREAM\0, 4-byte big-endian chunk lengths, zero-length terminator). */
export function clamdScanner(host: string, port = 3310, timeoutMs = 30000): Scanner {
  return {
    enabled: true,
    scan(bytes: Uint8Array): Promise<ScanResult> {
      return new Promise((resolve) => {
        let out = "";
        let done = false;
        const finish = (r: ScanResult) => { if (!done) { done = true; sock.destroy(); resolve(r); } };
        const sock = net.createConnection({ host, port });
        sock.setTimeout(timeoutMs, () => finish({ status: "ERROR", detail: "clamd timeout" }));
        sock.on("error", (e) => finish({ status: "ERROR", detail: `clamd error: ${e.message}` }));
        sock.on("data", (d) => { out += d.toString("utf8"); });
        sock.on("end", () => {
          const line = out.replace(/\0/g, "").trim();
          if (/: OK$/.test(line)) finish({ status: "CLEAN", detail: line });
          else if (/FOUND$/.test(line)) finish({ status: "INFECTED", detail: line });
          else finish({ status: "ERROR", detail: line || "empty clamd response" });
        });
        sock.on("connect", () => {
          sock.write("zINSTREAM\0");
          const CHUNK = 64 * 1024;
          for (let i = 0; i < bytes.length; i += CHUNK) {
            const chunk = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
            const len = Buffer.alloc(4);
            len.writeUInt32BE(chunk.length, 0);
            sock.write(len);
            sock.write(chunk);
          }
          sock.write(Buffer.alloc(4));
        });
      });
    },
  };
}

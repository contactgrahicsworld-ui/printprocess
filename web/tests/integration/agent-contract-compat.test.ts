import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { call, createTestEnv, ROOT, seedStaff, type TestEnv } from "../helpers/harness";
import * as agents from "@/app/api/admin/agents/route";
import * as heartbeat from "@/app/api/agent/heartbeat/route";

/**
 * Cross-checks the server against the print agent's OWN signing code (print-agent/src/hmac.ts, read-only import),
 * so both halves of CONTRACT.md agree byte-for-byte. Skipped if the agent source is not present.
 */
const agentHmac = join(ROOT, "../print-agent/src/hmac.ts");
const present = existsSync(agentHmac);

describe.skipIf(!present)("print-agent ⇄ server HMAC compatibility", () => {
  let env: TestEnv;
  let agentId: string;
  let secret: string;
  beforeAll(async () => {
    env = await createTestEnv();
    const owner = await seedStaff(env.db, "OWNER");
    const r = await call(agents.POST, "x", { staff: owner, body: { name: "compat" } });
    agentId = r.body.agentId;
    secret = r.body.secret;
  });

  it("heartbeat signed by print-agent/src/hmac.ts is accepted", async () => {
    const mod = (await import(/* @vite-ignore */ agentHmac)) as {
      deriveHmacKey(secret: string): string;
      buildSignedHeaders(o: { agentId: string; hmacKey: string; method: string; path: string; body: string; now: number }): Record<string, string>;
    };
    const body = JSON.stringify({ agentVersion: "1.0.0", hostname: "WIN-PC", printers: [] });
    const headers = mod.buildSignedHeaders({ agentId, hmacKey: mod.deriveHmacKey(secret), method: "POST", path: "/api/agent/heartbeat", body, now: Date.now() });
    const r = await call(heartbeat.POST, "/api/agent/heartbeat", { rawBody: body, headers: { ...headers, "content-type": "application/json" } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.ok).toBe(true);
  });
});

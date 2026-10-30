import { beforeAll, describe, expect, it, vi } from "vitest";
import { call, createTestEnv, seedQr, type TestEnv } from "../helpers/harness";
import { submitSimpleOrder } from "../helpers/flows";
import * as webhook from "@/app/api/webhooks/razorpay/route";
import * as rzOrder from "@/app/api/public/payments/razorpay/route";
import * as track from "@/app/api/public/track/route";
import { hmacHex } from "@/lib/security/crypto";

describe("Razorpay disabled (no keys)", () => {
  it("endpoints are hidden and tracking does not offer online payment", async () => {
    await createTestEnv();
    expect((await call(webhook.POST, "x", { rawBody: "{}" })).status).toBe(404);
    expect((await call(rzOrder.POST, "x", { body: { orderNumber: "MP-20260101-0001", token: "x" } })).status).toBe(404);
  });
});

describe("Razorpay enabled", () => {
  let env: TestEnv;
  let order: Awaited<ReturnType<typeof submitSimpleOrder>>;
  const WH = "whsec_test_123";
  beforeAll(async () => {
    env = await createTestEnv({ env: { RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "rzp_secret", RAZORPAY_WEBHOOK_SECRET: WH } });
    order = await submitSimpleOrder(await seedQr(env.db));
  });

  it("creates a gateway order server-side for the due amount (gateway HTTP mocked at fetch level)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "order_RZ1", amount: order.totalPaise }), { status: 200 }));
    const r = await call(rzOrder.POST, "x", { body: { orderNumber: order.orderNumber, token: order.trackingToken } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ keyId: "rzp_test_key", razorpayOrderId: "order_RZ1", amountPaise: order.totalPaise });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.razorpay.com/v1/orders");
    expect(JSON.parse(String((init as RequestInit).body)).amount).toBe(order.totalPaise);
    fetchMock.mockRestore();
    const t = await call(track.POST, "x", { body: { orderNumber: order.orderNumber, token: order.trackingToken } });
    expect(t.body.razorpayEnabled).toBe(true);
    expect(t.body.paidPaise).toBe(0); // creating a gateway order records NO payment
  });

  const event = (id: string, amount: number) => JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id, order_id: "order_RZ1", amount, status: "captured", method: "upi" } } } });

  it("rejects webhooks with a bad signature and records nothing", async () => {
    const body = event("pay_1", order.totalPaise);
    const r = await call(webhook.POST, "x", { rawBody: body, headers: { "x-razorpay-signature": hmacHex("wrong", body) } });
    expect(r.status).toBe(401);
    expect((await env.db.query("select 1 from payments")).length).toBe(0);
  });

  it("records ONLINE payment only on a verified webhook, exactly once", async () => {
    const body = event("pay_1", order.totalPaise);
    const sig = hmacHex(WH, body);
    expect((await call(webhook.POST, "x", { rawBody: body, headers: { "x-razorpay-signature": sig } })).body).toMatchObject({ recorded: true });
    expect((await call(webhook.POST, "x", { rawBody: body, headers: { "x-razorpay-signature": sig } })).body).toMatchObject({ duplicate: true });
    const p = await env.db.query<{ method: string; amount_paise: number; gateway_payment_id: string }>("select method, amount_paise, gateway_payment_id from payments");
    expect(p).toEqual([{ method: "ONLINE", amount_paise: order.totalPaise, gateway_payment_id: "pay_1" }]);
    const o = (await env.db.query<{ due_paise: number }>("select due_paise from orders where id = $1", [order.orderId]))[0]!;
    expect(o.due_paise).toBe(0);
  });
});

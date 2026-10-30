import { createHash, createHmac, randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";

// Must match scripts/dev-seed.mjs
const SEED = {
  staffId: "00000000-0000-4000-8000-000000000002",
  qrToken: "dev-qr-token-mansa-0001",
  agentId: "00000000-0000-4000-8000-0000000000a1",
  agentSecret: "dev-agent-secret-do-not-use-in-production-0001",
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function agentPost(request: APIRequestContext, path: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const ts = String(Date.now());
  const nonce = randomUUID();
  const sig = createHmac("sha256", sha(SEED.agentSecret)).update(`POST\n${path}\n${ts}\n${nonce}\n${sha(body)}`).digest("hex");
  const res = await request.post(path, {
    data: body,
    headers: { "content-type": "application/json", "x-agent-id": SEED.agentId, "x-agent-timestamp": ts, "x-agent-nonce": nonce, "x-agent-signature": sig },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function makePdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) doc.addPage([595, 842]).drawText(`E2E page ${i}`, { x: 60, y: 780, size: 28, font });
  return Buffer.from(await doc.save());
}

test("inactive QR shows a friendly error", async ({ page }) => {
  await page.goto("/s/not-a-real-token-123456");
  await expect(page.getByText("This QR code is not active")).toBeVisible();
});

test("customer → admin → agent → verify → pay → deliver (real UI, real API, real DB)", async ({ page, request }) => {
  page.on("dialog", (d) => void d.accept());

  // ---------------- customer portal (mobile viewport)
  await page.goto(`/s/${SEED.qrToken}`);
  await expect(page.getByRole("button", { name: /Choose files/ })).toBeEnabled();
  await page.getByTestId("file-input").setInputFiles({ name: "Physics notes.pdf", mimeType: "application/pdf", buffer: await makePdf(12) });
  const card = page.getByTestId("doc-card").first();
  await expect(card.getByText("12 pages")).toBeVisible();
  await card.getByRole("button", { name: "Both sides" }).click();
  await card.getByRole("button", { name: "Select pages" }).click();
  await card.getByLabel("Page ranges").fill("1-3,7,10-12");
  await card.getByRole("button", { name: "More copies" }).click();
  await page.locator("#cust-name").fill("Ravi Kumar");
  await page.locator("#cust-phone").fill("9876543210");
  // 7 pages × 2 copies = 14 printed sides × ₹1.50 (B/W double-side rate) = ₹21.00
  await expect(page.getByTestId("total")).toHaveText("₹21.00");
  await expect(card.getByText("14 printed sides, 8 sheets")).toBeVisible();
  await page.getByTestId("submit").click();
  await page.waitForURL(/\/t\/MP-\d{8}-\d{4}\?k=/);
  const orderNumber = (await page.getByTestId("order-number").textContent())!.trim();
  const trackUrl = page.url();
  await expect(page.getByTestId("order-status")).toContainText("Received");
  await expect(page.getByTestId("due")).toHaveText("₹21.00");

  // ---------------- agent comes online
  await agentPost(request, "/api/agent/heartbeat", { agentVersion: "1.0.0", hostname: "COUNTER-PC", printers: [{ name: "HP LaserJet M1136", isDefault: true, status: "Normal", supportsColor: false, supportsDuplex: true, paperSizes: ["A4", "Legal"] }] });

  // ---------------- staff dashboard
  await page.goto(`/api/dev/login?user=${SEED.staffId}`);
  await page.waitForURL("**/admin");
  await page.getByRole("link", { name: orderNumber }).click();
  await expect(page.getByTestId("admin-order-status")).toHaveText("RECEIVED");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("admin-order-status")).toHaveText("APPROVED");
  await page.getByLabel("Agent").selectOption({ label: "Dev Counter PC (online)" });
  await page.getByLabel("Printer").selectOption("HP LaserJet M1136");
  await page.getByRole("button", { name: "Send to printer" }).click();
  await expect(page.getByTestId("admin-order-status")).toHaveText("PRINTING");
  await expect(page.getByTestId("job-status").first()).toContainText("Queued");

  // ---------------- agent claims and reports spooler progress
  const claimed = await agentPost(request, "/api/agent/jobs/claim", { printers: ["HP LaserJet M1136"] });
  expect(claimed.jobs).toHaveLength(1);
  const job = claimed.jobs[0];
  expect(job.orderNumber).toBe(orderNumber);
  expect(job.settings).toEqual({ colorMode: "BW", duplex: "DOUBLE", paperSize: "A4", copies: 2, pageRanges: "1-3,7,10-12" });
  const file = await request.get(job.downloadUrl);
  expect(sha((await file.body()) as unknown as string)).toBe(job.sha256);
  for (const status of ["DOWNLOADED", "SUBMITTED", "SPOOLED", "PRINTING", "COMPLETED_SPOOLER"]) {
    await agentPost(request, `/api/agent/jobs/${job.jobId}/status`, { status, spoolerJobId: 42, detail: `e2e ${status}`, pagesPrinted: status === "COMPLETED_SPOOLER" ? 14 : null, at: Date.now() });
  }
  await page.reload();
  await expect(page.getByTestId("job-status").first()).toContainText("NOT VERIFIED");
  await expect(page.getByTestId("admin-order-status")).toHaveText("PRINTING");

  // ---------------- staff verifies physical print, takes payment, delivers, issues receipt
  await page.getByRole("button", { name: "Verify printed" }).click();
  await expect(page.getByTestId("admin-order-status")).toHaveText("READY");
  await expect(page.getByTestId("job-status").first()).toContainText("VERIFIED printed by staff");
  await page.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByTestId("admin-due")).toHaveText("₹0.00");
  await page.getByRole("button", { name: "Mark delivered" }).click();
  await expect(page.getByTestId("admin-order-status")).toHaveText("DELIVERED");
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Generate receipt" }).click();
  const popup = await popupPromise;
  await expect(popup.getByText("RECEIPT")).toBeVisible();
  await expect(popup.getByText(orderNumber)).toBeVisible();

  // ---------------- customer sees the final state
  await page.goto(trackUrl);
  await expect(page.getByTestId("order-status")).toContainText("Delivered");
  await expect(page.getByTestId("due")).toHaveText("₹0.00");
});

"use client";

/** First-page thumbnail for a local PDF (rendered in the browser with pdf.js; worker served from our origin). */
export async function pdfThumbnail(file: File, width = 160): Promise<string | null> {
  try {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const page = await doc.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / vp1.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
    const url = canvas.toDataURL("image/jpeg", 0.8);
    await doc.destroy();
    return url;
  } catch {
    return null;
  }
}

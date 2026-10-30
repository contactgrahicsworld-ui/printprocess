/**
 * Runs ONLY on Windows (GitHub Actions windows-latest / shop PC): exercises the real
 * PowerShell scripts against the real spooler. Skipped on Linux.
 */
import { describe, expect, it } from 'vitest';
import { WindowsPrinterBackend } from '../src/printer/windows.js';

const isWin = process.platform === 'win32';

describe.skipIf(!isWin)('WindowsPrinterBackend (real PowerShell)', () => {
  const b = new WindowsPrinterBackend({ sumatraPath: 'C:\\nonexistent\\SumatraPDF.exe', psTimeoutMs: 60000 });

  it('PowerShell and spooler are reachable', async () => {
    expect(await b.powershellVersion()).toMatch(/^\d+\.\d+/);
    expect(typeof (await b.isSpoolerRunning())).toBe('boolean');
  }, 90000);

  it('lists printers and parses statuses/capabilities', async () => {
    const ps = await b.listPrinters();
    expect(Array.isArray(ps)).toBe(true);
    for (const p of ps) {
      expect(typeof p.name).toBe('string');
      expect(p.status).toBeTruthy();
    }
    if (ps.length) {
      const one = await b.getPrinter(ps[0]!.name);
      expect(one?.name).toBe(ps[0]!.name);
      expect(Array.isArray(await b.listSpoolerJobs(ps[0]!.name))).toBe(true);
    }
  }, 90000);

  it('event 307 query never throws', async () => {
    expect(Array.isArray(await b.readPrintedEvents(Date.now() - 3600_000))).toBe(true);
  }, 90000);

  it('DPAPI LocalMachine round trip', async () => {
    const blob = await b.protectSecret('s3cr3t-ü');
    expect(blob).not.toContain('s3cr3t');
    expect(await b.unprotectSecret(blob)).toBe('s3cr3t-ü');
  }, 90000);

  it('Sumatra missing → submit reports process start failure', async () => {
    const r = await b.submitPdf({ printerName: 'x', filePath: 'C:\\x.pdf', printSettings: '1x', timeoutMs: 5000 });
    expect(r.exitCode).toBeNull();
  }, 30000);
});

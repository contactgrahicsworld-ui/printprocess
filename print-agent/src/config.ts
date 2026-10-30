import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export function defaultBaseDir(): string {
  if (process.platform === 'win32') {
    return join(process.env['ProgramData'] ?? 'C:\\ProgramData', 'MansaPrintAgent');
  }
  return join(process.env['HOME'] ?? '/tmp', '.mansa-print-agent');
}

export function defaultConfigPath(): string {
  return process.env['MPA_CONFIG'] ?? join(defaultBaseDir(), 'config.json');
}

const printerOverride = z.object({
  supportsColor: z.boolean().optional(),
  supportsDuplex: z.boolean().optional(),
  paperSizes: z.array(z.string()).optional(),
});

export const ConfigSchema = z.object({
  serverUrl: z.string().url(),
  agentId: z.string().min(1),
  /** DPAPI (LocalMachine) protected, base64. Preferred on Windows. */
  secretProtected: z.string().optional(),
  /** Plain secret. Only for development / non-Windows; `setup` never writes this on Windows. */
  secret: z.string().optional(),
  /** If non-empty, only these printers are used and advertised. */
  printerAllowlist: z.array(z.string()).default([]),
  /** Used when a job has printerName = null. Falls back to Windows default printer. */
  defaultPrinter: z.string().nullable().default(null),
  sumatraPath: z.string().default('C:\\Program Files\\MansaPrintAgent\\SumatraPDF.exe'),
  /** Optional pin: refuse to start printing if SumatraPDF.exe hash differs. */
  sumatraSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).nullable().default(null),
  sumatraScaling: z.enum(['noscale', 'shrink', 'fit']).nullable().default('shrink'),
  logDir: z.string().optional(),
  dataDir: z.string().optional(),
  tempDir: z.string().optional(),
  /** Keep downloaded files N hours after a final status (reprint debugging). 0 = delete immediately. */
  keepTempHours: z.number().min(0).default(0),
  heartbeatIntervalMs: z.number().int().min(1000).default(30000),
  claimIntervalMs: z.number().int().min(100).default(5000),
  spoolerPollMs: z.number().int().min(10).default(2000),
  /** After submit, if the job is never seen in the spooler within this time → ERROR "not observed in spooler". */
  notObservedTimeoutMs: z.number().int().min(10).default(60000),
  /** Max time to keep monitoring a spooled job before reporting ERROR (stuck in queue). */
  monitorTimeoutMs: z.number().int().min(100).default(4 * 60 * 60 * 1000),
  /**
   * Max time to wait for an offline / paper-out / errored printer BEFORE submit. The job stays
   * CLAIMED on the server meanwhile (printer state is visible via heartbeat); when this expires the
   * matching PRINTER_OFFLINE / PAPER_OUT / ERROR is reported as final (job never submitted).
   */
  maxPrinterWaitMs: z.number().int().min(10).default(15 * 60 * 1000),
  printerWaitInitialMs: z.number().int().min(10).default(5000),
  printerWaitMaxBackoffMs: z.number().int().min(10).default(60000),
  submitTimeoutMs: z.number().int().min(100).default(180000),
  maxDownloadBytes: z.number().int().min(1).default(200 * 1024 * 1024),
  requestTimeoutMs: z.number().int().min(100).default(20000),
  networkMaxBackoffMs: z.number().int().min(10).default(60000),
  networkInitialBackoffMs: z.number().int().min(1).default(1000),
  /** Development only: permit http:// for localhost/127.0.0.1. */
  allowInsecureLocalhost: z.boolean().default(false),
  /**
   * Event ID 307 (Microsoft-Windows-PrintService/Operational) as completion evidence:
   *  off     – not used
   *  confirm – used as additional evidence (can confirm a fast job that left the queue before it was observed)
   *  require – COMPLETED_SPOOLER is only sent when a matching 307 event exists
   */
  eventLog307: z.enum(['off', 'confirm', 'require']).default('off'),
  eventLog307WaitMs: z.number().int().min(0).default(15000),
  /** Manual capability overrides for drivers that misreport (keyed by printer name). */
  printerOverrides: z.record(printerOverride).default({}),
  logMaxBytes: z.number().int().min(1024).default(5 * 1024 * 1024),
  logMaxFiles: z.number().int().min(1).default(10),
});

export type AgentConfig = z.infer<typeof ConfigSchema>;

export interface ResolvedPaths {
  configPath: string;
  baseDir: string;
  logDir: string;
  dataDir: string;
  tempDir: string;
}

export function resolvePaths(cfg: AgentConfig, configPath: string): ResolvedPaths {
  const baseDir = dirname(configPath);
  return {
    configPath,
    baseDir,
    logDir: cfg.logDir ?? join(baseDir, 'logs'),
    dataDir: cfg.dataDir ?? join(baseDir, 'data'),
    tempDir: cfg.tempDir ?? join(baseDir, 'tmp'),
  };
}

export class ConfigError extends Error {}

export function parseConfig(raw: unknown): AgentConfig {
  const r = ConfigSchema.safeParse(raw);
  if (!r.success) {
    throw new ConfigError('invalid config: ' + r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const cfg = r.data;
  if (!cfg.secret && !cfg.secretProtected) throw new ConfigError('config needs secretProtected (or secret for development)');
  assertServerUrlAllowed(cfg.serverUrl, cfg.allowInsecureLocalhost);
  return cfg;
}

export function loadConfig(path = defaultConfigPath()): AgentConfig {
  if (!existsSync(path)) throw new ConfigError(`config not found at ${path}; run "MansaPrintAgent.exe setup" first`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new ConfigError(`config ${path} is not valid JSON: ${(e as Error).message}`);
  }
  return parseConfig(raw);
}

/** Atomic write: temp file + fsync + rename. */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  const fd = openSync(tmp, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function saveConfig(path: string, cfg: Partial<AgentConfig> & Record<string, unknown>): void {
  writeFileAtomic(path, JSON.stringify(cfg, null, 2) + '\n');
}

const LOCALHOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isUrlAllowed(url: string, allowInsecureLocalhost: boolean): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:' && allowInsecureLocalhost && LOCALHOSTS.has(u.hostname)) return true;
  return false;
}

export function assertServerUrlAllowed(url: string, allowInsecureLocalhost: boolean): void {
  if (!isUrlAllowed(url, allowInsecureLocalhost)) {
    throw new ConfigError(`refusing non-HTTPS URL ${url} (http is only allowed for localhost with allowInsecureLocalhost=true)`);
  }
}

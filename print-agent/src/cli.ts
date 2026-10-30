import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import {
  ConfigError,
  ConfigSchema,
  assertServerUrlAllowed,
  defaultConfigPath,
  loadConfig,
  resolvePaths,
  saveConfig,
  type AgentConfig,
} from './config.js';
import { RotatingJsonLogger } from './logger.js';
import { InstanceLock } from './lock.js';
import { ApiClient } from './apiClient.js';
import { Agent } from './agent.js';
import { deriveHmacKey } from './hmac.js';
import { WindowsPrinterBackend } from './printer/windows.js';
import type { PrinterBackend } from './printer/backend.js';
import { makeTestPagePdf } from './pdf.js';
import { buildPrintSettings } from './sumatra.js';
import { monitorSpoolerJob } from './monitor.js';
import { isBlocking } from './capability.js';
import { AGENT_VERSION } from './types.js';

const HELP = `Mansa Print Agent ${AGENT_VERSION}

Usage: MansaPrintAgent.exe <command> [options]

Commands:
  run                      Run the agent (used by the Windows service)
  setup                    Write %ProgramData%\\MansaPrintAgent\\config.json (asks for server URL, agent id, secret)
       --server-url URL --agent-id ID --secret-env VAR | --secret-stdin
       [--printer NAME] [--allow PRINTER]... [--sumatra PATH] [--no-test]
  list-printers            Show printers with status and capabilities (JSON with --json)
  test-print <printer>     Print a real 1-page test page and report the spooler result
       [--color] [--duplex] [--paper A4|A3|LEGAL]
  doctor                   Check SumatraPDF, PowerShell, spooler, config, connectivity, clock skew
  version                  Print version

Options:
  --config PATH            Config path (default ${defaultConfigPath()}; env MPA_CONFIG)
`;

export interface ParsedArgs {
  cmd: string;
  positional: string[];
  flags: Map<string, string[]>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [cmd = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  const booleans = new Set(['json', 'color', 'duplex', 'no-test', 'secret-stdin', 'help']);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const eq = name.indexOf('=');
      if (eq >= 0) {
        const k = name.slice(0, eq);
        flags.set(k, [...(flags.get(k) ?? []), name.slice(eq + 1)]);
      } else if (booleans.has(name)) {
        flags.set(name, ['true']);
      } else {
        const v = rest[++i] ?? '';
        flags.set(name, [...(flags.get(name) ?? []), v]);
      }
    } else positional.push(a);
  }
  return { cmd, positional, flags };
}

const flag = (a: ParsedArgs, k: string): string | undefined => a.flags.get(k)?.[0];

function requireWindows(): void {
  if (process.platform !== 'win32') {
    throw new Error('This command needs Windows (PowerShell + Print Spooler). The agent only runs on Windows 10/11.');
  }
}

function defaultSumatraPath(): string {
  const besideExe = join(dirname(process.execPath), 'SumatraPDF.exe');
  if (existsSync(besideExe)) return besideExe;
  return ConfigSchema.shape.sumatraPath.parse(undefined);
}

function makeBackend(cfg: Pick<AgentConfig, 'sumatraPath'> | null): PrinterBackend {
  requireWindows();
  return new WindowsPrinterBackend({ sumatraPath: cfg?.sumatraPath ?? defaultSumatraPath() });
}

async function resolveSecret(cfg: AgentConfig, backend: PrinterBackend): Promise<string> {
  if (cfg.secretProtected) return backend.unprotectSecret(cfg.secretProtected);
  if (cfg.secret) return cfg.secret;
  throw new ConfigError('no secret in config');
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function verifySumatra(cfg: AgentConfig): void {
  if (!existsSync(cfg.sumatraPath)) throw new Error(`SumatraPDF not found at ${cfg.sumatraPath} (see docs/PRINT_AGENT_INSTALL.md)`);
  if (cfg.sumatraSha256) {
    const h = sha256File(cfg.sumatraPath);
    if (h.toLowerCase() !== cfg.sumatraSha256.toLowerCase()) throw new Error(`SumatraPDF hash mismatch: config pins ${cfg.sumatraSha256}, file is ${h}`);
  }
}

// ---------------------------------------------------------------- prompts

async function ask(question: string, opts: { hidden?: boolean; def?: string } = {}): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const q = `${question}${opts.def ? ` [${opts.def}]` : ''}: `;
  const p = new Promise<string>((resolve) => rl.question(q, (a) => resolve(a)));
  muted = !!opts.hidden;
  const answer = (await p).trim();
  rl.close();
  if (opts.hidden) process.stdout.write('\n');
  return answer || opts.def || '';
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

// ---------------------------------------------------------------- commands

async function cmdSetup(a: ParsedArgs, configPath: string): Promise<number> {
  requireWindows();
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  const interactive = !flag(a, 'server-url');
  const serverUrl = flag(a, 'server-url') ?? (await ask('Server URL (https://...)', { def: (existing['serverUrl'] as string) ?? '' }));
  assertServerUrlAllowed(serverUrl, existing['allowInsecureLocalhost'] === true);
  const agentId = flag(a, 'agent-id') ?? (await ask('Agent ID (from dashboard)', { def: (existing['agentId'] as string) ?? '' }));
  let secret: string;
  const secretEnv = flag(a, 'secret-env');
  if (secretEnv) secret = process.env[secretEnv] ?? '';
  else if (a.flags.has('secret-stdin')) secret = await readStdin();
  else secret = await ask('Agent secret (shown once in dashboard; input hidden)', { hidden: true });
  if (!agentId || !secret) throw new ConfigError('agent id and secret are required');

  const sumatraPath = flag(a, 'sumatra') ?? (existing['sumatraPath'] as string | undefined) ?? defaultSumatraPath();
  const backend = makeBackend({ sumatraPath });
  let defaultPrinter = flag(a, 'printer') ?? (existing['defaultPrinter'] as string | null | undefined) ?? null;
  if (interactive && !flag(a, 'printer')) {
    try {
      const printers = await backend.listPrinters();
      console.log('\nPrinters on this PC:');
      printers.forEach((p, i) => console.log(`  ${i + 1}. ${p.name}${p.isDefault ? ' (Windows default)' : ''} — ${p.status}, color=${p.supportsColor}, duplex=${p.supportsDuplex}, paper=${p.paperSizes.join('/')}`));
      const pick = await ask('Default printer for jobs without a printer (number or name, blank = Windows default)', { def: defaultPrinter ?? '' });
      const n = Number(pick);
      defaultPrinter = pick === '' ? null : Number.isInteger(n) && printers[n - 1] ? printers[n - 1]!.name : pick;
    } catch (e) {
      console.warn(`Could not list printers: ${(e as Error).message}`);
    }
  }
  const allow = a.flags.get('allow');

  const secretProtected = await backend.protectSecret(secret);
  // sanity: round-trip
  if ((await backend.unprotectSecret(secretProtected)) !== secret) throw new Error('DPAPI round-trip failed');

  const next: Record<string, unknown> = { ...existing, serverUrl, agentId, secretProtected, sumatraPath, defaultPrinter };
  delete next['secret'];
  if (allow) next['printerAllowlist'] = allow;
  const cfg = ConfigSchema.parse(next);
  mkdirSync(dirname(configPath), { recursive: true });
  saveConfig(configPath, next);
  try {
    await backend.restrictPath(dirname(configPath), true);
    await backend.restrictPath(configPath, false);
  } catch (e) {
    console.warn(`WARNING: could not restrict ACL: ${(e as Error).message} (run setup as Administrator)`);
  }
  console.log(`Config written to ${configPath} (secret encrypted with DPAPI LocalMachine; ACL SYSTEM+Administrators).`);

  if (!a.flags.has('no-test')) {
    const api = new ApiClient({ serverUrl: cfg.serverUrl, agentId: cfg.agentId, hmacKey: deriveHmacKey(secret), allowInsecureLocalhost: cfg.allowInsecureLocalhost, timeoutMs: cfg.requestTimeoutMs });
    try {
      const printers = await backend.listPrinters().catch(() => []);
      const r = await api.heartbeat({ agentVersion: AGENT_VERSION, hostname: hostname(), printers: printers.map(({ statusDetail: _s, ...p }) => p) });
      console.log(`Server accepted signed heartbeat (serverTime ${new Date(r.serverTime).toISOString()}, clock offset ${api.clockOffsetMs} ms).`);
    } catch (e) {
      console.error(`Heartbeat test FAILED: ${(e as Error).message}`);
      return 2;
    }
  }
  return 0;
}

async function cmdListPrinters(a: ParsedArgs, configPath: string): Promise<number> {
  let cfg: AgentConfig | null = null;
  try {
    cfg = loadConfig(configPath);
  } catch {
    cfg = null;
  }
  const backend = makeBackend(cfg);
  const printers = await backend.listPrinters();
  if (a.flags.has('json')) {
    console.log(JSON.stringify(printers, null, 2));
    return 0;
  }
  if (!printers.length) console.log('No printers found.');
  for (const p of printers) {
    const allowed = cfg && cfg.printerAllowlist.length ? (cfg.printerAllowlist.includes(p.name) ? ' [allowed]' : ' [not in allowlist]') : '';
    console.log(`${p.isDefault ? '*' : ' '} ${p.name}${allowed}`);
    console.log(`    status: ${p.status}  (${p.statusDetail})`);
    console.log(`    color: ${p.supportsColor}  duplex: ${p.supportsDuplex}  paper: ${p.paperSizes.join(', ') || '(none reported)'}`);
  }
  return 0;
}

async function cmdTestPrint(a: ParsedArgs, configPath: string): Promise<number> {
  const printerName = a.positional[0];
  if (!printerName) throw new Error('usage: test-print "<printer name>"');
  let cfg: AgentConfig;
  try {
    cfg = loadConfig(configPath);
  } catch {
    cfg = ConfigSchema.parse({ serverUrl: 'https://unused.invalid', agentId: 'local', secret: 'x', sumatraPath: defaultSumatraPath() });
  }
  verifySumatra(cfg);
  const backend = makeBackend(cfg);
  const p = await backend.getPrinter(printerName);
  if (!p) {
    console.error(`Printer "${printerName}" not found. Run list-printers.`);
    return 2;
  }
  console.log(`Printer status: ${p.status} (${p.statusDetail})`);
  if (isBlocking(p.status)) {
    console.error(`Printer is ${p.status}; not submitting.`);
    return 3;
  }
  const paper = (flag(a, 'paper') ?? 'A4').toUpperCase() as 'A4' | 'A3' | 'LEGAL';
  const settings = { colorMode: a.flags.has('color') ? 'COLOR' : 'BW', duplex: a.flags.has('duplex') ? 'DOUBLE' : 'SINGLE', paperSize: paper, copies: 1, pageRanges: null } as const;
  const paths = resolvePaths(cfg, configPath);
  const dir = join(paths.tempDir, `test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const token = `MP_TEST_${randomUUID()}`;
  const file = join(dir, `${token}.pdf`);
  await makeTestPagePdf(file, { printerName, hostname: hostname(), agentVersion: AGENT_VERSION, now: new Date() });
  const printSettings = buildPrintSettings(settings, { scaling: cfg.sumatraScaling });
  console.log(`Submitting ${file}\n  -print-to "${printerName}" -print-settings "${printSettings}"`);
  const submittedAt = Date.now();
  const res = await backend.submitPdf({ printerName, filePath: file, printSettings, timeoutMs: cfg.submitTimeoutMs });
  console.log(`SumatraPDF exit code ${res.exitCode}${res.timedOut ? ' (timed out)' : ''}`);
  console.log('SUBMITTED — watching the Windows spooler...');
  const logger = new RotatingJsonLogger(paths.logDir, { maxBytes: cfg.logMaxBytes, maxFiles: cfg.logMaxFiles, baseName: 'test-print' });
  const result = await monitorSpoolerJob({
    backend,
    logger,
    printerName,
    docToken: token,
    submittedAt,
    knownSpoolerJobId: null,
    previouslySeen: false,
    resumed: false,
    pollMs: cfg.spoolerPollMs,
    notObservedTimeoutMs: cfg.notObservedTimeoutMs,
    monitorTimeoutMs: Math.min(cfg.monitorTimeoutMs, 15 * 60_000),
    eventLog307: cfg.eventLog307,
    eventLog307WaitMs: cfg.eventLog307WaitMs,
    onEmit: (e) => console.log(`${new Date().toISOString()}  ${e.status}  spoolerJobId=${e.spoolerJobId ?? '-'}  ${e.detail}`),
    shouldStop: () => false,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
  });
  console.log(`RESULT: ${result.status} spoolerJobId=${result.spoolerJobId ?? '-'} pagesPrinted=${result.pagesPrinted ?? '-'}\n  ${result.detail}`);
  if (cfg.keepTempHours === 0) rmSync(dir, { recursive: true, force: true });
  console.log('Now check the physical page (border complete, text sharp, timestamp matches).');
  return result.status === 'COMPLETED_SPOOLER' ? 0 : 4;
}

async function cmdDoctor(configPath: string): Promise<number> {
  let failures = 0;
  const ok = (m: string): void => console.log(`  [OK]   ${m}`);
  const bad = (m: string): void => {
    failures++;
    console.log(`  [FAIL] ${m}`);
  };
  const warn = (m: string): void => console.log(`  [WARN] ${m}`);
  console.log(`Mansa Print Agent ${AGENT_VERSION} doctor`);
  if (process.platform !== 'win32') bad(`platform is ${process.platform}; Windows required`);
  else ok(`Windows (${process.arch}), Node ${process.version}`);

  let cfg: AgentConfig | null = null;
  try {
    cfg = loadConfig(configPath);
    ok(`config ${configPath}`);
  } catch (e) {
    bad((e as Error).message);
  }
  if (process.platform !== 'win32') return 1;
  const backend = makeBackend(cfg) as WindowsPrinterBackend;

  const psv = await backend.powershellVersion();
  if (psv) ok(`PowerShell ${psv}`);
  else bad('PowerShell not usable (powershell.exe)');
  const spool = await backend.isSpoolerRunning();
  if (spool === true) ok('Print Spooler service running');
  else bad(`Print Spooler service not running (${String(spool)}) — run: Start-Service Spooler`);

  if (cfg) {
    try {
      verifySumatra(cfg);
      ok(`SumatraPDF ${cfg.sumatraPath} sha256=${sha256File(cfg.sumatraPath)}`);
    } catch (e) {
      bad((e as Error).message);
    }
    if (!cfg.sumatraSha256) warn('sumatraSha256 not pinned in config (recommended)');
  }

  try {
    const printers = await backend.listPrinters();
    ok(`${printers.length} printer(s): ${printers.map((p) => `${p.name}=${p.status}`).join('; ')}`);
    if (cfg) {
      for (const n of cfg.printerAllowlist) if (!printers.some((p) => p.name === n)) bad(`allowlisted printer "${n}" not installed (or not visible to this account)`);
      if (cfg.defaultPrinter && !printers.some((p) => p.name === cfg!.defaultPrinter)) bad(`defaultPrinter "${cfg.defaultPrinter}" not found`);
    }
  } catch (e) {
    bad(`printer discovery failed: ${(e as Error).message}`);
  }

  try {
    const out = await backend.runPs(
      "$ErrorActionPreference='Stop'; $l = Get-WinEvent -ListLog 'Microsoft-Windows-PrintService/Operational'; [Console]::Out.Write([string]$l.IsEnabled)",
    );
    if (out.trim() === 'True') ok('PrintService/Operational event log enabled (Event 307 available)');
    else (cfg?.eventLog307 === 'require' ? bad : warn)('PrintService/Operational log disabled: wevtutil sl Microsoft-Windows-PrintService/Operational /e:true');
  } catch (e) {
    warn(`could not read event log status: ${(e as Error).message}`);
  }

  if (cfg) {
    try {
      const secret = await resolveSecret(cfg, backend);
      ok('secret decrypted (DPAPI)');
      const api = new ApiClient({ serverUrl: cfg.serverUrl, agentId: cfg.agentId, hmacKey: deriveHmacKey(secret), allowInsecureLocalhost: cfg.allowInsecureLocalhost, timeoutMs: cfg.requestTimeoutMs });
      const t0 = Date.now();
      const r = await api.heartbeat({ agentVersion: AGENT_VERSION, hostname: hostname(), printers: [] });
      const rtt = Date.now() - t0;
      ok(`server reachable, signed heartbeat accepted (${rtt} ms)`);
      const skew = r.serverTime - (t0 + rtt / 2);
      if (Math.abs(skew) > 120_000) bad(`clock skew ${Math.round(skew / 1000)} s vs server — run: w32tm /resync`);
      else ok(`clock skew ${Math.round(skew)} ms`);
    } catch (e) {
      bad(`connectivity/auth: ${(e as Error).message}`);
    }
  }
  console.log(failures ? `\n${failures} problem(s) found.` : '\nAll checks passed.');
  return failures ? 1 : 0;
}

async function cmdRun(configPath: string): Promise<number> {
  const cfg = loadConfig(configPath);
  const paths = resolvePaths(cfg, configPath);
  const logger = new RotatingJsonLogger(paths.logDir, { maxBytes: cfg.logMaxBytes, maxFiles: cfg.logMaxFiles, echo: true, minLevel: 'info' });
  verifySumatra(cfg);
  const backend = makeBackend(cfg);
  const lock = new InstanceLock(join(paths.dataDir, 'agent.lock'));
  lock.acquire();
  const secret = await resolveSecret(cfg, backend);
  const api = new ApiClient({ serverUrl: cfg.serverUrl, agentId: cfg.agentId, hmacKey: deriveHmacKey(secret), allowInsecureLocalhost: cfg.allowInsecureLocalhost, timeoutMs: cfg.requestTimeoutMs });
  const agent = new Agent({ config: cfg, paths, backend, api, logger });
  process.on('unhandledRejection', (r) => logger.error('unhandled_rejection', { error: String((r as Error)?.stack ?? r) }));
  process.on('uncaughtException', (e) => logger.error('uncaught_exception', { error: e.stack ?? String(e) }));
  let stopping = false;
  const shutdown = (sig: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info('shutdown_signal', { sig });
    void agent.stop().finally(() => {
      lock.release();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));
  await agent.start();
  return new Promise<number>(() => undefined); // runs until signalled
}

export async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  const configPath = flag(a, 'config') ?? defaultConfigPath();
  switch (a.cmd) {
    case 'run':
      return cmdRun(configPath);
    case 'setup':
      return cmdSetup(a, configPath);
    case 'list-printers':
      return cmdListPrinters(a, configPath);
    case 'test-print':
      return cmdTestPrint(a, configPath);
    case 'doctor':
      return cmdDoctor(configPath);
    case 'version':
    case '--version':
    case '-v':
      console.log(AGENT_VERSION);
      return 0;
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command "${a.cmd}"\n`);
      console.log(HELP);
      return 64;
  }
}

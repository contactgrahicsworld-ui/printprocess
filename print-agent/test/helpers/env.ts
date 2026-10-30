import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Agent } from '../../src/agent.js';
import { ApiClient } from '../../src/apiClient.js';
import { parseConfig, resolvePaths, type AgentConfig } from '../../src/config.js';
import { MemoryLogger } from '../../src/logger.js';
import { deriveHmacKey } from '../../src/hmac.js';
import type { PrintJob } from '../../src/types.js';
import { FakeBackend } from './fakeBackend.js';
import { MockServer } from './mockServer.js';

export const PRINTER = 'HP LaserJet';
export const SECRET = 'super-secret-agent-key-32-bytes!!';

export interface TestEnv {
  dir: string;
  server: MockServer;
  backend: FakeBackend;
  agent: Agent;
  logger: MemoryLogger;
  config: AgentConfig;
  newAgent(): Agent;
  cleanup(): Promise<void>;
}

export async function makeEnv(overrides: Partial<AgentConfig> = {}, opts: { dir?: string; server?: MockServer; backend?: FakeBackend } = {}): Promise<TestEnv> {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'mpa-test-'));
  const server = opts.server ?? new MockServer();
  if (!opts.server) {
    await server.start();
    server.addAgent('agent-1', SECRET);
  }
  const backend = opts.backend ?? new FakeBackend();
  if (!opts.backend) backend.addPrinter({ name: PRINTER, isDefault: true });
  const config = parseConfig({
    serverUrl: server.url,
    agentId: 'agent-1',
    secret: SECRET,
    allowInsecureLocalhost: true,
    dataDir: join(dir, 'data'),
    tempDir: join(dir, 'tmp'),
    logDir: join(dir, 'logs'),
    heartbeatIntervalMs: 1000,
    claimIntervalMs: 100,
    spoolerPollMs: 20,
    notObservedTimeoutMs: 300,
    maxPrinterWaitMs: 5000,
    printerWaitInitialMs: 30,
    printerWaitMaxBackoffMs: 100,
    networkInitialBackoffMs: 20,
    networkMaxBackoffMs: 100,
    requestTimeoutMs: 2000,
    eventLog307WaitMs: 50,
    ...overrides,
  });
  const logger = new MemoryLogger(!!process.env['MPA_TEST_ECHO']);
  const newAgent = (): Agent =>
    new Agent({
      config,
      paths: resolvePaths(config, join(dir, 'config.json')),
      backend,
      api: new ApiClient({ serverUrl: config.serverUrl, agentId: config.agentId, hmacKey: deriveHmacKey(SECRET), allowInsecureLocalhost: true, timeoutMs: 2000 }),
      logger,
      hostname: 'SHOP-PC',
    });
  const agent = newAgent();
  return {
    dir,
    server,
    backend,
    agent,
    logger,
    config,
    newAgent,
    cleanup: async () => {
      await agent.stop().catch(() => undefined);
      if (!opts.server) await server.stop();
      if (!opts.dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function jobFor(overrides: Partial<PrintJob> = {}): Omit<PrintJob, 'downloadUrl' | 'sha256'> {
  return {
    jobId: randomUUID(),
    orderNumber: 'MP-20261030-0042',
    orderItemId: randomUUID(),
    attempt: 1,
    printerName: PRINTER,
    fileName: 'notes.pdf',
    mimeType: 'application/pdf',
    settings: { colorMode: 'BW', duplex: 'SINGLE', paperSize: 'A4', copies: 1, pageRanges: null },
    ...overrides,
  };
}

export async function waitFor(pred: () => boolean, timeoutMs = 10000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const FINAL = ['COMPLETED_SPOOLER', 'FAILED', 'ERROR'];

export async function waitFinal(env: TestEnv, jobId: string, attempt = 1, agent: Agent = env.agent): Promise<void> {
  await waitFor(() => agent.jobLog.get(jobId, attempt)?.state === 'FINAL' && agent.outbox.size() === 0, 15000, `job ${jobId} final + outbox drained`);
}

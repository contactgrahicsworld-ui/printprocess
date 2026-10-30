import { describe, expect, it } from 'vitest';
import { buildSignedHeaders, canonicalString, deriveHmacKey, sha256hex, signRequest, verifySignature } from '../src/hmac.js';

describe('HMAC signing per CONTRACT', () => {
  // Expected values computed independently with Python hashlib/hmac.
  const key = deriveHmacKey('test-secret');
  it('key = sha256hex(secret)', () => {
    expect(key).toBe('9caf06bb4436cdbfa20af9121a626bc1093c4f54b31c0fa937957856135345b6');
  });
  it('signature over METHOD\\npath\\nts\\nnonce\\nsha256hex(body) matches reference vector', () => {
    const body = '{"printers":["HP LaserJet"]}';
    expect(signRequest(key, 'POST', '/api/agent/jobs/claim', 1730000000000, '11111111-2222-3333-4444-555555555555', body)).toBe(
      '2b6332293d07521c297f4efa76f0f88d7fdb100937156863a3c3a5f2753a90c2',
    );
  });
  it('empty body hashes the empty string', () => {
    expect(canonicalString('post', '/api/agent/heartbeat', 1730000000000, 'n', '')).toBe(
      `POST\n/api/agent/heartbeat\n1730000000000\nn\n${sha256hex('')}`,
    );
    expect(signRequest(key, 'POST', '/api/agent/heartbeat', 1730000000000, 'n', '')).toBe('fd950e8642e485692632ca460e2cbeda36794164d4bddd48ebff8da1fd85af95');
  });
  it('headers + verification; tampering is detected', () => {
    const h = buildSignedHeaders({ agentId: 'a', hmacKey: key, method: 'POST', path: '/api/agent/heartbeat', body: '{}', now: 1730000000000.4 });
    expect(h['X-Agent-Timestamp']).toBe('1730000000000');
    expect(h['X-Agent-Nonce']).toMatch(/^[0-9a-f-]{36}$/);
    expect(verifySignature(key, 'POST', '/api/agent/heartbeat', h['X-Agent-Timestamp'], h['X-Agent-Nonce'], '{}', h['X-Agent-Signature'])).toBe(true);
    expect(verifySignature(key, 'POST', '/api/agent/heartbeat', h['X-Agent-Timestamp'], h['X-Agent-Nonce'], '{ }', h['X-Agent-Signature'])).toBe(false);
    expect(verifySignature(key, 'POST', '/api/agent/jobs/claim', h['X-Agent-Timestamp'], h['X-Agent-Nonce'], '{}', h['X-Agent-Signature'])).toBe(false);
    expect(verifySignature(deriveHmacKey('other'), 'POST', '/api/agent/heartbeat', h['X-Agent-Timestamp'], h['X-Agent-Nonce'], '{}', h['X-Agent-Signature'])).toBe(false);
    expect(verifySignature(key, 'POST', '/api/agent/heartbeat', h['X-Agent-Timestamp'], h['X-Agent-Nonce'], '{}', 'zz')).toBe(false);
  });
});

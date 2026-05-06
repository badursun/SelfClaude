import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setEnvVar } from '../src/lib/env.js';
import { generatePairingCode } from '../src/telegram/link.js';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'sc-env-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('setEnvVar appends a new key when missing', async () => {
  await withTempDir(async (dir) => {
    const envPath = join(dir, '.env');
    await writeFile(envPath, 'EXISTING=foo\n');
    await setEnvVar(envPath, 'NEW_KEY', 'bar');
    const content = await readFile(envPath, 'utf8');
    assert.match(content, /EXISTING=foo/);
    assert.match(content, /NEW_KEY=bar/);
    assert.ok(content.endsWith('\n'), 'should preserve trailing newline');
  });
});

test('setEnvVar updates an existing key in place (no duplicate)', async () => {
  await withTempDir(async (dir) => {
    const envPath = join(dir, '.env');
    await writeFile(envPath, 'TELEGRAM_CHAT_ID=\nFOO=bar\n');
    await setEnvVar(envPath, 'TELEGRAM_CHAT_ID', '12345');
    const content = await readFile(envPath, 'utf8');
    assert.match(content, /TELEGRAM_CHAT_ID=12345/);
    // Original empty line should be replaced, not duplicated
    assert.equal(content.match(/TELEGRAM_CHAT_ID/g)?.length, 1);
    assert.match(content, /FOO=bar/);
  });
});

test('setEnvVar creates the file if missing', async () => {
  await withTempDir(async (dir) => {
    const envPath = join(dir, '.env');
    await setEnvVar(envPath, 'KEY', 'value');
    const content = await readFile(envPath, 'utf8');
    assert.match(content, /KEY=value/);
  });
});

test('setEnvVar preserves quoted values on other lines', async () => {
  await withTempDir(async (dir) => {
    const envPath = join(dir, '.env');
    await writeFile(envPath, 'TELEGRAM_BOT_TOKEN="abc:DEF"\n');
    await setEnvVar(envPath, 'NEW', 'val');
    const content = await readFile(envPath, 'utf8');
    assert.match(content, /TELEGRAM_BOT_TOKEN="abc:DEF"/);
    assert.match(content, /NEW=val/);
  });
});

test('setEnvVar rejects invalid env keys', async () => {
  await withTempDir(async (dir) => {
    const envPath = join(dir, '.env');
    await assert.rejects(() => setEnvVar(envPath, 'lower-case', 'x'));
    await assert.rejects(() => setEnvVar(envPath, '1STARTS_WITH_DIGIT', 'x'));
    await assert.rejects(() => setEnvVar(envPath, 'WITH SPACE', 'x'));
  });
});

test('generatePairingCode produces an 8-char alphanumeric string (47-bit entropy)', () => {
  for (let i = 0; i < 50; i++) {
    const code = generatePairingCode();
    assert.match(code, /^[0-9A-Z]{8}$/, `unexpected code: ${code}`);
  }
  // Uniqueness: 50 generations should all be different (p ≈ 1 - (1/36^8)^50 ≈ negligible collision chance)
  const codes = new Set(Array.from({ length: 50 }, () => generatePairingCode()));
  assert.equal(codes.size, 50, 'expected all 50 codes to be unique');
});

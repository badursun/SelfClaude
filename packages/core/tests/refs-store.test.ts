import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addRef,
  buildRefsManifest,
  isValidRefName,
  listRefs,
  REFS_MAX_BYTES,
  removeRef,
} from '../src/project/refs-store.js';

async function withTempCwd(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'sc-refs-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('isValidRefName rejects path-traversal, hidden, separator, control, and overflow names', () => {
  assert.equal(isValidRefName('BRIEF.md'), true);
  assert.equal(isValidRefName('readme-1.txt'), true);
  assert.equal(isValidRefName('with space.md'), true);
  // Path-traversal / separators
  assert.equal(isValidRefName('../escape.md'), false);
  assert.equal(isValidRefName('a/b.md'), false);
  assert.equal(isValidRefName('a\\b.md'), false);
  // Hidden
  assert.equal(isValidRefName('.hidden'), false);
  // Empty / too long
  assert.equal(isValidRefName(''), false);
  assert.equal(isValidRefName('a'.repeat(201)), false);
  // Control chars
  assert.equal(isValidRefName('with\u0000null'), false);
});

test('addRef → listRefs round-trip preserves filename + size', async () => {
  await withTempCwd(async (cwd) => {
    const body = Buffer.from('# title\nbody\n');
    const r = await addRef(cwd, 'BRIEF.md', body);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.meta.name, 'BRIEF.md');
    assert.equal(r.meta.sizeBytes, body.length);
    assert.equal(r.renamed, false);

    const refs = await listRefs(cwd);
    assert.equal(refs.length, 1);
    assert.equal(refs[0]!.name, 'BRIEF.md');
    assert.equal(refs[0]!.sizeBytes, body.length);
  });
});

test('addRef on collision uses suffix-2, then suffix-3', async () => {
  await withTempCwd(async (cwd) => {
    const a = await addRef(cwd, 'spec.md', Buffer.from('one'));
    const b = await addRef(cwd, 'spec.md', Buffer.from('two'));
    const c = await addRef(cwd, 'spec.md', Buffer.from('three'));
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(c.ok, true);
    if (!a.ok || !b.ok || !c.ok) return;
    assert.equal(a.meta.name, 'spec.md');
    assert.equal(b.meta.name, 'spec-2.md');
    assert.equal(c.meta.name, 'spec-3.md');
    assert.equal(a.renamed, false);
    assert.equal(b.renamed, true);

    const refs = await listRefs(cwd);
    assert.deepEqual(
      refs.map((r) => r.name).sort(),
      ['spec-2.md', 'spec-3.md', 'spec.md'],
    );
  });
});

test('addRef rejects oversized payload + invalid name', async () => {
  await withTempCwd(async (cwd) => {
    const big = Buffer.alloc(REFS_MAX_BYTES + 1);
    const tooLarge = await addRef(cwd, 'huge.bin', big);
    assert.equal(tooLarge.ok, false);
    if (tooLarge.ok) return;
    assert.equal(tooLarge.reason, 'too-large');

    const bad = await addRef(cwd, '../escape.md', Buffer.from('x'));
    assert.equal(bad.ok, false);
    if (bad.ok) return;
    assert.equal(bad.reason, 'invalid-name');
  });
});

test('removeRef deletes existing, returns false on missing or invalid name', async () => {
  await withTempCwd(async (cwd) => {
    await addRef(cwd, 'doomed.md', Buffer.from('bye'));
    assert.equal(await removeRef(cwd, 'doomed.md'), true);
    assert.equal((await listRefs(cwd)).length, 0);

    assert.equal(await removeRef(cwd, 'never-existed.md'), false);
    assert.equal(await removeRef(cwd, '../escape.md'), false);
  });
});

test('buildRefsManifest is empty when no refs, otherwise lists each entry', async () => {
  await withTempCwd(async (cwd) => {
    assert.equal(await buildRefsManifest(cwd), '');

    await addRef(cwd, 'BRIEF.md', Buffer.from('a'.repeat(2048)));
    await addRef(cwd, 'spec.yaml', Buffer.from('b'.repeat(500)));
    const md = await buildRefsManifest(cwd);
    assert.match(md, /## Reference documents/);
    assert.match(md, /`BRIEF\.md` \(2 KB\)/);
    assert.match(md, /`spec\.yaml` \(500 B\)/);
  });
});

test('listRefs ignores invalid filenames a subprocess may have planted', async () => {
  await withTempCwd(async (cwd) => {
    // Write a hidden file directly on disk — listRefs must skip it.
    const dir = join(cwd, '.selfclaude', 'refs');
    await (await import('node:fs/promises')).mkdir(dir, { recursive: true });
    await (await import('node:fs/promises')).writeFile(join(dir, '.secret'), 'x');
    await addRef(cwd, 'visible.md', Buffer.from('y'));
    const refs = await listRefs(cwd);
    assert.equal(refs.length, 1);
    assert.equal(refs[0]!.name, 'visible.md');
  });
});

test('readRef returns the bytes back; null for missing or invalid', async () => {
  await withTempCwd(async (cwd) => {
    const { readRef } = await import('../src/project/refs-store.js');
    await addRef(cwd, 'roundtrip.md', Buffer.from('hello'));
    const buf = await readRef(cwd, 'roundtrip.md');
    assert.ok(buf);
    assert.equal(buf.toString('utf8'), 'hello');

    assert.equal(await readRef(cwd, 'gone.md'), null);
    assert.equal(await readRef(cwd, '../etc/passwd'), null);
  });
});

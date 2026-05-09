import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStableTag, pickLatestReleaseTag } from '../src/release-target.js';

test('parseStableTag accepts strict vMAJOR.MINOR.PATCH', () => {
  assert.deepEqual(parseStableTag('v0.0.1'), {
    tag: 'v0.0.1',
    major: 0,
    minor: 0,
    patch: 1,
  });
  assert.deepEqual(parseStableTag('v1.20.345'), {
    tag: 'v1.20.345',
    major: 1,
    minor: 20,
    patch: 345,
  });
});

test('parseStableTag rejects pre-releases, partial versions, and unrelated tags', () => {
  assert.equal(parseStableTag('v0.2.0-rc.1'), null);
  assert.equal(parseStableTag('v0.2.0-beta'), null);
  assert.equal(parseStableTag('v0.1'), null);
  assert.equal(parseStableTag('v0.1.0.4'), null);
  assert.equal(parseStableTag('release-1.0.0'), null);
  assert.equal(parseStableTag('1.0.0'), null);
  assert.equal(parseStableTag('v'), null);
  assert.equal(parseStableTag(''), null);
});

test('pickLatestReleaseTag picks the highest stable tag and ignores the rest', () => {
  const tags = [
    'v0.1.0',
    'v0.0.1',
    'v0.2.0-rc.1',
    'v0.2.0',
    'release-old',
    'v0.1.5',
    '',
  ];
  assert.equal(pickLatestReleaseTag(tags), 'v0.2.0');
});

test('pickLatestReleaseTag respects numeric (not lexical) ordering', () => {
  // Lexical sort would put v0.10.0 BEFORE v0.9.0 — make sure we don't.
  assert.equal(pickLatestReleaseTag(['v0.9.0', 'v0.10.0', 'v0.2.5']), 'v0.10.0');
  assert.equal(pickLatestReleaseTag(['v1.0.0', 'v0.99.99']), 'v1.0.0');
});

test('pickLatestReleaseTag returns null when nothing matches', () => {
  assert.equal(pickLatestReleaseTag([]), null);
  assert.equal(pickLatestReleaseTag(['main', 'feature/foo', 'v0.1']), null);
  assert.equal(pickLatestReleaseTag(['v0.1.0-rc.1', 'v0.2.0-beta']), null);
});

test('pickLatestReleaseTag tolerates whitespace and empty lines from git output', () => {
  // Output of `git tag -l` can include blank lines or trailing spaces
  // depending on the shell pipe — strip and parse robustly.
  const fromGit = '\nv0.1.0\nv0.2.0  \n\n  v0.0.1\n';
  assert.equal(pickLatestReleaseTag(fromGit.split('\n')), 'v0.2.0');
});

/**
 * Operator-attached reference documents.
 *
 * Files live under `<cwd>/.selfclaude/refs/` keyed by their original
 * filename. The supervisor sees a small manifest (filename + size)
 * appended to its system prompt every turn; the file *content* is read
 * lazily by sup with the regular Read tool, so a 5MB doc costs zero
 * tokens unless it actually opens it.
 *
 * Design choices:
 *   • One flat directory — no nesting. Operators upload via UI, names
 *     stay short, no scenario yet that needs subfolders.
 *   • Originals preserved — same filename on disk as on upload, so
 *     when sup resolves a path from the manifest it lines up. Name
 *     collision yields `name-2.ext`, `name-3.ext`, etc.
 *   • 5 MB cap per file — keeps the upload UX honest (this isn't a
 *     code repository) and protects the chat-log from churning if a
 *     huge file gets dropped.
 *   • Filename safety enforced here, not at the API layer — anyone
 *     calling `addRef` from inside core gets the same guarantees.
 */

import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';

export const REFS_DIRNAME = 'refs';
export const REFS_MAX_BYTES = 5 * 1024 * 1024;

export interface RefMeta {
  name: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface AddRefOk {
  ok: true;
  meta: RefMeta;
  /** True when the original name collided and we used a `-2` style suffix. */
  renamed: boolean;
}

export interface AddRefErr {
  ok: false;
  reason: 'invalid-name' | 'too-large' | 'write-failed';
  message: string;
}

export type AddRefResult = AddRefOk | AddRefErr;

export function refsDir(cwd: string): string {
  return join(cwd, '.selfclaude', REFS_DIRNAME);
}

/**
 * True iff `name` is safe to use as a refs-dir filename. Rejects path
 * separators, parent-dir traversal, hidden-file dots, empty or huge
 * names. Does *not* validate extension — operators may upload .md,
 * .pdf, .png, .yaml; sup's Read tool sorts out what it can open.
 */
export function isValidRefName(name: string): boolean {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > 200) return false;
  if (name.startsWith('.')) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (name.includes('..')) return false;
  // Reserve null bytes and control chars; some filesystems accept
  // them but they trip every downstream tool that touches the path.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) return false;
  return true;
}

export async function listRefs(cwd: string): Promise<RefMeta[]> {
  const dir = refsDir(cwd);
  if (!existsSync(dir)) return [];
  const names = await readdir(dir);
  const out: RefMeta[] = [];
  for (const name of names) {
    if (!isValidRefName(name)) continue;
    try {
      const s = await stat(join(dir, name));
      if (!s.isFile()) continue;
      out.push({ name, sizeBytes: s.size, mtimeMs: s.mtimeMs });
    } catch {
      // Race: file removed between readdir and stat — skip silently.
    }
  }
  // Stable order so the manifest doesn't churn with each disk listing.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function readRef(cwd: string, name: string): Promise<Buffer | null> {
  if (!isValidRefName(name)) return null;
  const path = join(refsDir(cwd), name);
  if (!existsSync(path)) return null;
  return await readFile(path);
}

/**
 * Resolve a write target for `name`. If the file already exists, walk
 * `name-2.ext`, `name-3.ext`, … up to a sensible bound before giving
 * up. The bound (50) is well past anything an operator would
 * realistically reach; if we hit it, something is wrong (probably a
 * race or a script churning the dir) and we'd rather error than spin.
 */
function resolveCollisionName(dir: string, name: string): string | null {
  if (!existsSync(join(dir, name))) return name;
  const ext = extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let n = 2; n <= 50; n++) {
    const candidate = `${base}-${n}${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
  return null;
}

export async function addRef(
  cwd: string,
  name: string,
  content: Buffer,
): Promise<AddRefResult> {
  if (!isValidRefName(name)) {
    return {
      ok: false,
      reason: 'invalid-name',
      message: 'filename contains invalid characters or is too long',
    };
  }
  if (content.length > REFS_MAX_BYTES) {
    return {
      ok: false,
      reason: 'too-large',
      message: `file is ${content.length} bytes; cap is ${REFS_MAX_BYTES}`,
    };
  }
  const dir = refsDir(cwd);
  await mkdir(dir, { recursive: true });
  const finalName = resolveCollisionName(dir, name);
  if (finalName === null) {
    return {
      ok: false,
      reason: 'write-failed',
      message: `too many name collisions for "${name}"; rename and retry`,
    };
  }
  try {
    await writeFile(join(dir, finalName), content);
  } catch (e) {
    return { ok: false, reason: 'write-failed', message: (e as Error).message };
  }
  const s = await stat(join(dir, finalName));
  return {
    ok: true,
    meta: { name: finalName, sizeBytes: s.size, mtimeMs: s.mtimeMs },
    renamed: finalName !== name,
  };
}

export async function removeRef(cwd: string, name: string): Promise<boolean> {
  if (!isValidRefName(name)) return false;
  const path = join(refsDir(cwd), name);
  if (!existsSync(path)) return false;
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the supervisor system-prompt manifest from the current refs
 * dir. Returns an empty string when the dir is empty so callers can
 * append unconditionally without worrying about trailing whitespace.
 *
 * The format is deliberately compact: filename + human size, one per
 * line. Sup sees this every turn — anything fancier (descriptions,
 * inferred content type, modification dates) inflates token usage
 * for marginal value.
 */
export async function buildRefsManifest(cwd: string): Promise<string> {
  const refs = await listRefs(cwd);
  if (refs.length === 0) return '';
  const lines = refs.map((r) => `- \`${r.name}\` (${humanSize(r.sizeBytes)})`);
  return [
    '## Reference documents',
    '',
    'The operator has attached the following documents at `.selfclaude/refs/`. Read them with the Read tool when relevant — treat them as authoritative for the questions they answer. The list can change between turns.',
    '',
    ...lines,
    '',
  ].join('\n');
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

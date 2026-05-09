/**
 * Release-tag selection for `selfclaude update`.
 *
 * The update command's default mode is "pull the latest tagged
 * release" — not main HEAD. Tag selection happens here as a pure
 * function so it's straightforward to test without invoking git.
 *
 * Robustness notes:
 *   • Strict semver regex (`vMAJOR.MINOR.PATCH`) rejects
 *     pre-releases (`v0.2.0-rc.1`) and any noise (`v0.1`,
 *     `release-1`, etc.). Pre-releases never count as "latest
 *     stable"; users who want them pass `--edge`.
 *   • Numeric component comparison — `v0.10.0 > v0.9.0` correctly,
 *     which `git tag --sort=-version:refname` mostly handles but we
 *     don't want to depend on git's locale-sort quirks.
 *   • Stable order: equal-rank tags would be a bug upstream; we
 *     just pick the first one in the descending sort.
 */

export interface SemverTag {
  tag: string;
  major: number;
  minor: number;
  patch: number;
}

const STABLE_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;

/**
 * Parse a candidate tag into its semver components, or `null` if it's
 * not a stable release tag.
 */
export function parseStableTag(tag: string): SemverTag | null {
  const m = STABLE_TAG_RE.exec(tag);
  if (!m) return null;
  return {
    tag,
    major: Number.parseInt(m[1]!, 10),
    minor: Number.parseInt(m[2]!, 10),
    patch: Number.parseInt(m[3]!, 10),
  };
}

/**
 * Pick the highest-versioned stable release tag from a list (typically
 * the output of `git tag -l 'v*'`). Returns `null` when no valid
 * stable tag is present — caller decides what to do (in `selfclaude
 * update`, that's an error message + suggestion to pass `--edge`).
 */
export function pickLatestReleaseTag(tags: readonly string[]): string | null {
  const candidates: SemverTag[] = [];
  for (const t of tags) {
    const parsed = parseStableTag(t.trim());
    if (parsed) candidates.push(parsed);
  }
  candidates.sort((a, b) => {
    if (a.major !== b.major) return b.major - a.major;
    if (a.minor !== b.minor) return b.minor - a.minor;
    return b.patch - a.patch;
  });
  return candidates[0]?.tag ?? null;
}

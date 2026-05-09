# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html);
breaking changes can land in `0.x` minor bumps until v1.0.

## [0.1.0] — 2026-05-09

First release after v0.0.1 with meaningful surface changes — new
features, accumulated bug fixes, and a small backward-incompatible
clean-up. Pre-1.0 so a minor bump covers the breakage.

### Added
- **Reference documents.** Operator can attach project briefs / specs
  / design docs to a session via the right-pane "References" tab
  (📎). Files persist to `<cwd>/.selfclaude/refs/`; sup sees a
  manifest in its system prompt every turn and reads contents
  lazily with the Read tool. 5 MB cap per file. Adds and removes
  audit-trail through chat-log.
- **`selfclaude update` CLI command** (PR #3 by
  @KilimcininKorOglu). One-step `git fetch` + reinstall +
  daemon restart. Refuses on uncommitted local changes; pass
  `--force` to discard them.
- **Phase 5/6/7 integration tests.** End-to-end coverage of the
  isolation discard endpoint, decision-report markdown export, and
  turn-error / stuck-detector SSE event emission paths.

### Changed
- **Removed the legacy Ink TUI package.** The web UI has covered
  every TUI feature since the v0.0.1 release. Dropping the package
  fixed a pre-existing typecheck error and shed 40+ resolved deps.

### Removed
- **`selfclaude start --tui`, `--demo`, `--cwd` flags.** The TUI
  removal above. Folded into `selfclaude start` (web mode is the
  only mode now).

### Fixed
- **i18n hydration mismatch on first client render.** The locale
  store was reading localStorage at module load, so a TR user's
  first client render disagreed with the SSR-rendered HTML. Store
  now starts as `en` everywhere; a `useEffect` in `useTranslation`
  syncs from localStorage post-hydration.
- **Stuck-detector false positive on session restart.** SessionManager
  restored `supMetrics.totalTurns` from disk but left
  `lastProgressTs` null on boot, so a freshly resumed session was
  immediately classified `no-progress-yet`. Detector now seeds from
  the most recent progress marker in the chat-log on boot.
- **Pinned-project metric placeholders leaking into the UI**
  (`{totalTurns}`, `{filesTouched}`, `{passPct}`, `{estimateMin}`,
  `{min}/{hr}/{day}`, `{docCount}`, `{delta}`). Translation calls
  passed parameter names that didn't match the locale templates.
- **Agent tab strip overflow on narrow viewports.** Equal-share
  layout with `truncate` so all five agent tabs always fit on one
  line; coloured icons at rest (not just when active); refactorer
  recoloured zinc → sky to stay distinct from the strip's neutral
  idle treatment.

[0.1.0]: https://github.com/badursun/SelfClaude/releases/tag/v0.1.0

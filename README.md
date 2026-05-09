# SelfClaude

An **autonomous multi-agent layer** on top of [Claude Code](https://docs.claude.com/en/docs/claude-code/quickstart). You hand the supervisor a goal; it plans, delegates to specialists (developer · ui-dev · security · tester · refactorer), verifies their output (reads files, runs tests, opens pages in Chrome, reads logs), and gates phases — without you sitting at the keyboard for each step. You only get pulled in for ambiguous trade-offs or destructive actions. Everything else runs.

Off-screen escalation goes through Telegram (optional). The chat-log + per-session git branch capture every decision, so you can step away for an hour and come back to a reviewable diff.

Install Claude Code first if you don't already use it — this is a layer, not a replacement.

---

## What a session looks like

You open a folder, type into the chat box:

> Refactor `src/server.ts` to split the route registration into its own file. Then make sure tests still pass.

What sup actually does (rendered from `chat-log.jsonl` for readability — real sessions are noisier):

```
sup              Plan: refactorer splits, then tester verifies.
sup → refactorer Split route registration from src/server.ts into src/routes.ts.
refactorer       Refused: "typecheck on the baseline already has 3 errors in
                 src/server.ts. Refactoring on a red tree is unsafe — please
                 re-route to developer to fix those first."
sup              Fair. Re-routing.

sup → developer  Fix the 3 typecheck errors in src/server.ts.
developer        Edit src/server.ts (+9, -7).
                 Bash: pnpm typecheck → 1 error remaining (missed import).
developer        Edit src/server.ts (+1, -0).
                 Bash: pnpm typecheck → green.

sup → refactorer Now split route registration as planned.
refactorer       Edit src/server.ts (-15), Edit src/routes.ts (+18).
                 Bash: pnpm test → 12/12 pass.

sup              I should run tester separately to double-check?
you              No, refactorer already ran the suite. Continue.
sup              Phase complete.
```

Four things to notice:
1. **You were here for one prompt and one one-line correction.** The rest — three delegations, a refusal, a re-route, an incomplete-fix retry, a typecheck pass, a test pass — all happened without you. That's the loop: you set direction, sup runs the work, you sign off.
2. **Refactorer refused.** Its contract says "no rework on a red baseline." Sup adapted instead of forcing.
3. **Developer's first fix was incomplete.** Forgot an import; typecheck caught it; second pass fixed it. Sup didn't ask you to look — it kept the inner loop tight on its own.
4. **Sup over-asked at the end** — wanted to re-run the suite via `tester` even though `refactorer` had already run it. Sup is conservative when it isn't sure; that's where your one-line corrections come in. Common over-asks: "should I commit this?", "do you want a security pass?", "phase complete?". Always one-line answers.

Two commits land on a session-scoped git branch (if isolation is enabled — one-click toggle in the status bar). Click **Accept** to squash-merge into your branch, **Discard** to wipe the branch and restore the worktree.

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/badursun/SelfClaude/main/install.sh | bash
```

The script lives at [install.sh](./install.sh) — read it first if piping random scripts to bash makes you uneasy. (Reasonable.)

**It does not:**
- ask for `sudo` or root.
- touch `/etc`, `/usr`, `~/.bashrc`, or any system config.
- modify your global `~/.claude/settings.json` — your existing Claude Code setup is left exactly where it is.
- write anywhere outside `~/.selfclaude/` and a single symlink target.

**What it does:**
1. Pre-flights Node ≥20, pnpm (auto-installs via corepack if missing), and `claude` CLI signed in. Aborts with a fix-it message if any are missing.
2. Clones into `~/.selfclaude/app/`.
3. Runs `pnpm install --frozen-lockfile` inside that dir. No global npm installs.
4. Symlinks a `selfclaude` command into `/usr/local/bin` (or `~/.local/bin` if no write access).

Removes cleanly: `rm -rf ~/.selfclaude/` plus deleting the symlink. Update with `selfclaude update` (pulls the latest tagged release + reinstalls deps + restarts the daemon if running). Pass `--edge` to track `origin/main` instead.

macOS + Linux only; Windows is untested.

## Quickstart

```bash
selfclaude start
```

Opens http://127.0.0.1:3000/ in your browser. Open a folder, fill the wizard (or "Discover existing" for an already-built repo), type a request to sup.

The empty home page also has a **5-minute demo** button — it scaffolds a single-file portfolio HTML and opens it in your browser. Useful for seeing the shape of the orchestration before pointing it at real code.

---

## What can break

Real things, observed during development. Listed worst-first by user impact, not roadmap importance.

- **`ExitPlanMode` freezes the turn.** [hard lock] No UI affordance to approve plan-mode exits yet. The `security` agent has been explicitly prompted not to call `ExitPlanMode` (returns findings as text; sup writes the report file as proxy). If you write a custom prompt for an agent in plan mode, instruct it the same way or your turn will hang on `Exit plan mode?` and you'll need to abort + restart.

- **Parallel agents share one git branch.** [silent corruption risk] Phase 5 isolates the *session*, not individual agents. Two parallel agents writing to the same file fall back to the in-memory file-lock manager, which prevents the in-flight Edit collision but doesn't help if both ended up committing changes that conflict. Per-agent worktree (Phase 5b) is on the roadmap; for now, prefer serial dispatch when two agents touch the same file.

- **Long sessions get expensive fast.** [money risk, recoverable] A 1-hour session can burn through more API credit than the same work split into 4 fresh sessions, because token cost grows with conversation length and there's no auto-checkpoint yet. Watch the cost badge in the bottom toolbar; restart when it's growing faster than the work is.

- **Sup picks the wrong agent ~5–10% of the time.** [quality, recoverable] Phase 8's decision rubric reduces this but doesn't eliminate it. If you see a feature task land on `tester` or a refactor land on `developer`, intervene with a clarifying message — sup will re-route.

- **Stuck detector misfires during long discovery.** [UX nuisance] Default threshold is 5 minutes without a file change or phase decision. If sup is genuinely thinking through an ambiguous spec with you, the amber banner will pop. Dismiss it.

- **Linux works but is less tested than macOS.** [env-specific] Hook scripts assume `bash 4+`, `lsof`, `ps`. On Alpine + busybox you'll hit issues. Windows is entirely untested.

- **It's v0.x.** [general] Breaking changes between minor versions are possible until 1.0.

If any of these are dealbreakers — wait a release cycle, or open an issue describing your specific failure mode.

---

## How it works

The default mode is **autonomous**: sup runs without operator intervention until it finishes the goal or hits something it can't decide alone.

Three-step loop:

1. **You write** a request to sup in the chat box (and then can leave).
2. **Sup reads** the request, your `CLAUDE.md`, and any prior session state. It plans, writes a phase doc, registers tracker items, then delegates to specialists. After each agent reports back, sup verifies the work itself — reads the changed files, runs `pnpm test` or `curl` smoke checks via Bash, opens the page in Chrome to confirm a UI render, reads logs. Marks items done or sends them back. Walks itself across phases until done.
3. **Sup pulls you in** only when it has to: an ambiguous trade-off (`ask_user`), a destructive action (`request_user_approval`), a security concern that needs your call. Telegram bridges these to your phone if you're not at the keyboard.

The implication: between your initial prompt and the next time you check in, the system is doing real work — not waiting for you to click "next." The chat-log captures everything so review is post-hoc, not real-time.

**How sup decides who gets what.** Prompt-based, not deterministic — the decision rubric lives in `supervisor.md`. A simplified decision tree:

```
task starts with "add a test" / "verify" / "regression"  → tester
task starts with "rename" / "split" / "dedupe" / "tighten types" → refactorer
                                                                    (refuses if it touches behaviour)
task is read-only audit (secrets, injection, auth, deps)  → security
                                                            (returns findings as text; sup writes the report)
task is frontend (.tsx, components, layouts, forms)  → ui-dev
otherwise (backend, scripts, configs, general)  → developer
```

Sup mostly follows this. When it doesn't, it explains its reasoning in the chat — you can intervene.

The roster:

| Role | What it does |
|---|---|
| `supervisor` | Always-on. Plans, delegates, gates phases. |
| `developer` | Backend / general-purpose default. |
| `ui-dev` | Frontend specialist (shadcn / Tailwind / admin panel). |
| `security` | Read-only auditor. Returns findings as text; never edits. |
| `tester` | Verification-only. Writes + runs tests; refuses to edit product code. |
| `refactorer` | Bounded rework. Refuses features, new deps, behaviour changes. |

Hard-capped at 6 for v1.0. Custom roles will eventually drop in via `~/.selfclaude/agents.json` (plugin system pending).

Everything hangs off the chat-log on disk at `<your-project>/.selfclaude/chat-log.jsonl` — append-only, replayable. Two files in `.selfclaude/` you'll actually look at:

- `chat-log.jsonl` — every event (turns, tool calls, decisions, file changes).
- `phases.json` — structured phase tracker (Definition-of-Done items + status).

The rest is machine-managed (settings, hooks, scripts, telemetry). Your global `~/.claude/settings.json` is **not** touched.

**Handing sup a brief.** If you have a PRD, spec, or design doc you want sup to use as source-of-truth, drop it into the **References** tab on the right pane (📎 icon). Files persist to `<cwd>/.selfclaude/refs/` and sup sees a manifest of them in its system prompt every turn — it reads the contents lazily with the Read tool, so a 5 MB brief costs zero tokens unless sup actually opens it. Add or remove files anytime; the next sup turn picks up the change automatically.

---

## CLI

| Command | Purpose |
|---|---|
| `selfclaude start` | Start the daemon (web UI auto-opens) |
| `selfclaude stop` | Graceful shutdown |
| `selfclaude restart` | Reload after pulling new code |
| `selfclaude status` | Daemon up? PID, web URL |
| `selfclaude logs` / `logs -f` | Tail run log |
| `selfclaude link-telegram` | Pair a Telegram chat for off-screen prompts |
| `selfclaude update` | Pull latest **release** + reinstall deps + restart daemon (`--edge` to track main) |
| `selfclaude doctor` | Sanity-check env + Telegram |

## Config

Optional `.env` — only for Telegram:

```ini
TELEGRAM_BOT_TOKEN=          # @BotFather
TELEGRAM_CHAT_ID=            # auto-filled by `selfclaude link-telegram`
```

`ANTHROPIC_API_KEY` is **not** read here — the `claude` CLI handles auth.

## Optional: Claude in Chrome

Sup has the `--chrome` flag enabled. If you've installed [Claude in Chrome](https://claude.ai/chrome), sup can browse + inspect pages as part of verification (open a deploy, check a route renders). Specialists don't have Chrome on purpose. If the extension isn't installed, sup just notes Chrome tools aren't available; nothing breaks.

---

## Architecture

**Where the decisions happen** (the runtime loop — read these if you want to understand the system):

- `packages/core/src/orchestrator/` — FSM, message bus, agent dispatch, phase contracts, stuck detector, failure-mode catalog.
- `packages/core/src/hooks/` — bash hook scripts post into a random-port HTTP bridge; this intercepts every tool call.
- `packages/core/src/mcp/` — stdio MCP server CC subprocesses spawn against; bridges `ask_user`, `request_user_approval`, phase tracker, etc.

**Surface** (UI + CLI + state — the parts you can swap):

- `packages/web/` — Next.js UI. This is the surface, not where the decisions happen.
- `packages/cli/` — daemon control.
- `packages/core/src/server/` — Fastify + SSE.
- `packages/core/src/agents/` — registry + DNA loader.
- `packages/core/src/project/` — `.selfclaude/*` round-trippers.

## Tests

```bash
pnpm test              # unit (300+) — about 6s
pnpm test:integration  # live `claude` subprocess tests — costs API credits
pnpm typecheck         # all packages
```

## Troubleshooting

- **`claude: command not found`** — install Claude Code: <https://docs.claude.com/en/docs/claude-code/quickstart>
- **Stale daemon after a crash** — `selfclaude stop` (handles stale PID files). Last resort: `rm ~/.selfclaude/run.pid && selfclaude start`.
- **Telegram not working** — `selfclaude doctor` checks bot reachability + chat pairing.
- **"Lost connection" toast** — fixed in current main; if you see it, share `selfclaude logs --orchestrator | tail -30` in an issue.
- **Session looks stuck (amber banner)** — stuck detector fired. Send a follow-up prompt, click Stop on the active turn, or wait if you know it's working in the background.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Short version: terse code, tests required, scoped diffs, no new built-in agents (cap is 6).

## License

[Business Source License 1.1](./LICENSE) — free for individual + small-team use (≤10 people), commercial licensing required for larger organizations or anyone offering it as a hosted service. Converts to **Apache 2.0** on **2030-05-08**.

For commercial licensing, see [COMMERCIAL.md](./COMMERCIAL.md) or email **badursun@gmail.com**.

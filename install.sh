#!/usr/bin/env bash
#
# SelfClaude installer — clones the repo, installs deps, and links a
# global `selfclaude` command.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/badursun/SelfClaude/main/install.sh | bash
#
# What it does:
#   1. Pre-flight: checks Node 20+, pnpm (auto-installs via corepack if
#      possible), and the `claude` CLI (Anthropic Claude Code).
#   2. Clones SelfClaude into ~/.selfclaude/app (or pulls if already there).
#   3. Runs `pnpm install --frozen-lockfile` inside it.
#   4. Symlinks the launcher script to a directory on $PATH:
#        - /usr/local/bin/selfclaude  (preferred, needs sudo on most setups)
#        - $HOME/.local/bin/selfclaude (fallback, you may need to add to PATH)
#   5. Prints next-step instructions.
#
# Re-run safely; the script is idempotent.

set -euo pipefail

REPO_URL="${SELFCLAUDE_REPO_URL:-https://github.com/badursun/SelfClaude.git}"
INSTALL_DIR="${SELFCLAUDE_INSTALL_DIR:-$HOME/.selfclaude/app}"
BRANCH="${SELFCLAUDE_BRANCH:-main}"

# ─── Output helpers ─────────────────────────────────────────────────
# Colours go through tput so terminals without colour support degrade
# silently to plain text. The `|| true` swallows tput's exit when run
# in a CI / pipe context where TERM isn't set.
if [[ -t 1 ]] && command -v tput >/dev/null 2>&1; then
  BOLD=$(tput bold || true)
  DIM=$(tput dim || true)
  GREEN=$(tput setaf 2 || true)
  YELLOW=$(tput setaf 3 || true)
  RED=$(tput setaf 1 || true)
  CYAN=$(tput setaf 6 || true)
  RESET=$(tput sgr0 || true)
else
  BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; CYAN=""; RESET=""
fi

info()  { printf '%s%s%s\n'      "$CYAN" "$*" "$RESET"; }
ok()    { printf '%s✓%s %s\n'    "$GREEN" "$RESET" "$*"; }
warn()  { printf '%s⚠%s %s\n'    "$YELLOW" "$RESET" "$*" >&2; }
fail()  { printf '%s✗ %s%s\n'    "$RED" "$*" "$RESET" >&2; exit 1; }
hint()  { printf '%s  → %s%s\n'  "$DIM" "$*" "$RESET"; }
hr()    { printf '\n%s──────────────────────────────────────────────%s\n\n' "$DIM" "$RESET"; }

banner() {
  printf '\n%s%sSelfClaude installer%s\n' "$BOLD" "$CYAN" "$RESET"
  printf '%smulti-agent Claude Code orchestration%s\n\n' "$DIM" "$RESET"
}

banner

# ─── Pre-flight: Node 20+ ───────────────────────────────────────────
info "Checking Node.js…"
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js is not installed. SelfClaude needs Node 20+.

  Install from https://nodejs.org/ or with nvm:
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
    nvm install 20"
fi

NODE_VERSION_RAW=$(node --version)
NODE_MAJOR=$(printf '%s' "$NODE_VERSION_RAW" | sed -E 's/^v([0-9]+).*/\1/')
if [[ -z "$NODE_MAJOR" ]] || [[ "$NODE_MAJOR" -lt 20 ]]; then
  fail "Node $NODE_VERSION_RAW found; SelfClaude needs Node 20 or newer.
  Use nvm: nvm install 20 && nvm use 20"
fi
ok "Node $NODE_VERSION_RAW"

# ─── Pre-flight: pnpm (auto-install via corepack if needed) ─────────
info "Checking pnpm…"
if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    warn "pnpm not found — bootstrapping via corepack"
    corepack enable
    corepack prepare pnpm@latest --activate
  else
    fail "pnpm not found and corepack is unavailable.

  Install pnpm manually:
    npm install -g pnpm
  Or enable corepack (Node 16+):
    corepack enable && corepack prepare pnpm@latest --activate"
  fi
fi
PNPM_VERSION=$(pnpm --version)
ok "pnpm $PNPM_VERSION"

# ─── Pre-flight: claude CLI (Anthropic Claude Code) ─────────────────
# This is the big one. SelfClaude is a wrapper *around* Claude Code; it
# spawns `claude` subprocesses to drive the supervisor + specialists.
# Without it, nothing works — we surface a clear error rather than
# proceeding into a confusing runtime failure later.
info "Checking Claude Code CLI…"
if ! command -v claude >/dev/null 2>&1; then
  warn "The 'claude' CLI is not installed yet."
  hint "SelfClaude orchestrates Claude Code subprocesses. You need the official CLI:"
  hint "  1. Install:  https://docs.claude.com/en/docs/claude-code/quickstart"
  hint "  2. Run 'claude' once to sign in (links to your Anthropic / Claude account)"
  hint "  3. Re-run this installer"
  fail "Claude Code CLI is required."
fi
CLAUDE_VERSION=$(claude --version 2>/dev/null | head -n1 || printf 'unknown')
ok "claude CLI: $CLAUDE_VERSION"

# ─── Pre-flight: git ────────────────────────────────────────────────
if ! command -v git >/dev/null 2>&1; then
  fail "git is not installed (needed to clone the repo)."
fi
ok "git $(git --version | awk '{print $3}')"

hr

# ─── Clone or update ────────────────────────────────────────────────
# Default mode pins to the latest stable release tag (`vMAJOR.MINOR.PATCH`
# only, no pre-releases). Set `SELFCLAUDE_EDGE=1` to track origin/$BRANCH
# instead — the bleeding-edge channel for contributors / CI. The two paths
# share the same fetch + reset machinery so an existing install on edge
# can flip back to stable just by re-running without the env var.
info "Installing SelfClaude into $INSTALL_DIR"
mkdir -p "$(dirname "$INSTALL_DIR")"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  ok "Existing install found — fetching"
  git -C "$INSTALL_DIR" fetch --tags --prune-tags origin "$BRANCH"
elif [[ -e "$INSTALL_DIR" ]]; then
  fail "$INSTALL_DIR exists but isn't a git checkout. Move or remove it and re-run."
else
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  # The shallow clone above only fetches main; tags need a follow-up
  # fetch so the latest-release pick below has anything to choose from.
  git -C "$INSTALL_DIR" fetch --tags --prune-tags origin
  ok "Cloned to $INSTALL_DIR"
fi

# Pick the target ref: latest stable tag by default, origin/$BRANCH when
# the operator opts into edge.
TARGET=""
TARGET_LABEL=""
if [[ "${SELFCLAUDE_EDGE:-0}" == "1" ]]; then
  TARGET="origin/$BRANCH"
  TARGET_LABEL="$BRANCH (edge)"
else
  # Strict semver tags only — pre-release tags (vX.Y.Z-rc.1, vX.Y.Z-beta)
  # never count as "latest stable". Sort numerically by stripping the leading
  # `v` and feeding to sort -V; head -n1 picks the highest.
  LATEST_TAG=$(git -C "$INSTALL_DIR" tag -l 'v*' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -V \
    | tail -n1)
  if [[ -n "$LATEST_TAG" ]]; then
    TARGET="$LATEST_TAG"
    TARGET_LABEL="$LATEST_TAG"
  else
    warn "No stable release tags found — falling back to origin/$BRANCH"
    TARGET="origin/$BRANCH"
    TARGET_LABEL="$BRANCH (no tags)"
  fi
fi

git -C "$INSTALL_DIR" reset --hard "$TARGET"
ok "Checked out $TARGET_LABEL"

# ─── Install dependencies ───────────────────────────────────────────
info "Installing dependencies (pnpm install)…"
(cd "$INSTALL_DIR" && pnpm install --frozen-lockfile --silent)
ok "Dependencies installed"

# ─── Symlink the launcher into PATH ─────────────────────────────────
LAUNCHER="$INSTALL_DIR/packages/cli/selfclaude.mjs"
if [[ ! -x "$LAUNCHER" ]]; then
  chmod +x "$LAUNCHER"
fi

# Try preferred system path first; fall back to user-local if write
# permission isn't there (no sudo prompts in a curl-piped install).
LINK_DIR=""
LINK_TARGET=""
if [[ -w "/usr/local/bin" ]]; then
  LINK_DIR="/usr/local/bin"
elif [[ -w "/opt/homebrew/bin" ]]; then
  LINK_DIR="/opt/homebrew/bin"
elif mkdir -p "$HOME/.local/bin" 2>/dev/null && [[ -w "$HOME/.local/bin" ]]; then
  LINK_DIR="$HOME/.local/bin"
else
  fail "No writable directory found for the symlink. Tried:
    /usr/local/bin
    /opt/homebrew/bin
    \$HOME/.local/bin

  Either re-run with sudo:
    sudo bash $0
  Or symlink manually:
    ln -s $LAUNCHER /somewhere/in/your/PATH/selfclaude"
fi

LINK_TARGET="$LINK_DIR/selfclaude"

# Replace any existing symlink (idempotent updates); refuse to clobber
# a non-symlink file the user might have placed manually.
if [[ -L "$LINK_TARGET" ]]; then
  rm "$LINK_TARGET"
elif [[ -e "$LINK_TARGET" ]]; then
  fail "$LINK_TARGET exists but isn't a symlink. Move it aside and re-run."
fi
ln -s "$LAUNCHER" "$LINK_TARGET"
ok "Linked $LINK_TARGET → $LAUNCHER"

# Warn if the chosen dir isn't on PATH (only relevant for ~/.local/bin)
case ":$PATH:" in
  *":$LINK_DIR:"*) ;;
  *)
    warn "$LINK_DIR is not on your PATH. Add it to your shell config:"
    hint "  bash:  echo 'export PATH=\"$LINK_DIR:\$PATH\"' >> ~/.bashrc"
    hint "  zsh:   echo 'export PATH=\"$LINK_DIR:\$PATH\"' >> ~/.zshrc"
    ;;
esac

hr

# ─── Done ───────────────────────────────────────────────────────────
printf '%s%sInstall complete.%s\n\n' "$BOLD" "$GREEN" "$RESET"
printf '  Start the daemon:\n'
printf '    %sselfclaude start%s\n\n' "$BOLD" "$RESET"
printf '  Web UI opens automatically at %shttp://127.0.0.1:3000/%s\n\n' "$CYAN" "$RESET"
printf '  Other commands:\n'
printf '    selfclaude status      check if running\n'
printf '    selfclaude restart     reload code changes\n'
printf '    selfclaude logs -f     tail daemon logs\n'
printf '    selfclaude stop        graceful shutdown\n'
printf '    selfclaude update      pull latest + reinstall deps\n\n'
printf '  Optional setup:\n'
printf '    Telegram fallback for unanswered prompts:  selfclaude link-telegram\n'
printf '    Chrome integration for sup verification:    https://claude.ai/chrome\n\n'

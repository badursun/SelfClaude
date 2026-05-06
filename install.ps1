#Requires -Version 5.1

param(
  [uri]$RepoUrl = 'https://github.com/badursun/SelfClaude.git',
  [string]$InstallDir = "$env:USERPROFILE\.selfclaude\app",
  [string]$Branch = 'main'
)

$ErrorActionPreference = 'Stop'

Write-Host ''
Write-Host 'SelfClaude installer (Windows)' -ForegroundColor Cyan
Write-Host '  multi-agent Claude Code orchestration' -ForegroundColor DarkGray
Write-Host ''

function info  ($msg) { Write-Host "  $msg" -ForegroundColor Cyan }
function ok    ($msg) { Write-Host "[OK] $msg" -ForegroundColor Green }
function warn  ($msg) { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function fail  ($msg) {
  Write-Host "[ERROR] $msg" -ForegroundColor Red
  exit 1
}
function hint ($msg) { Write-Host "    -> $msg" -ForegroundColor DarkGray }

function Test-CommandExists($cmd) {
  $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue)
}

# Pre-flight: Node 20+
info 'Checking Node.js...'
if (-not (Test-CommandExists node)) {
  fail 'Node.js is not installed. Install from https://nodejs.org/'
}
$nodeVer = [version]((node --version) -replace '^v', '')
if ($nodeVer.Major -lt 20) {
  fail "Node $($nodeVer.ToString()) found; SelfClaude needs Node 20 or newer."
}
ok "Node $($nodeVer.ToString())"

# Pre-flight: pnpm
info 'Checking pnpm...'
if (-not (Test-CommandExists pnpm)) {
  warn 'pnpm not found — installing via npm'
  npm install -g pnpm 2>$null | Out-Null
  if (-not (Test-CommandExists pnpm)) { fail 'Could not install pnpm.' }
}
ok "pnpm $(pnpm --version)"

# Pre-flight: Claude Code CLI (check via cmd /c so .cmd wrapper resolves)
info 'Checking Claude Code CLI...'
$claudeVersion = $null
try {
  $raw = cmd /c claude --version 2>$null
  if ($raw) { $claudeVersion = [regex]::Match($raw, '^[\d.]+').Value }
} catch {}
if (-not $claudeVersion) {
  warn "The 'claude' CLI is not installed yet."
  hint 'Install: https://docs.claude.com/en/docs/claude-code/quickstart'
  hint "Run 'claude' once to sign in, then re-run this installer."
  fail 'Claude Code CLI is required.'
}
ok "claude CLI: $claudeVersion"

# Pre-flight: git
info 'Checking git...'
if (-not (Test-CommandExists git)) {
  fail 'git is not installed. Install from https://git-scm.com/'
}
$gitVer = (git --version) -replace 'git version ', ''
ok "git $gitVer"

Write-Host ''
Write-Host '------------------------------------------------' -ForegroundColor DarkGray
Write-Host ''

# Clone or update
info "Installing to $InstallDir"
$parentDir = Split-Path $InstallDir -Parent
if (-not (Test-Path $parentDir)) {
  New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
}

if (Test-Path "$InstallDir\.git") {
  ok 'Existing install found — pulling latest from origin/main'
  Push-Location $InstallDir
  try {
    $null = git pull origin $Branch
  } finally { Pop-Location }
} elseif (Test-Path $InstallDir) {
  fail "$InstallDir exists but is not a git checkout. Remove it and re-run."
} else {
  git clone --depth 1 --branch $Branch $RepoUrl $InstallDir
  ok "Cloned to $InstallDir"
}

# Install dependencies
info 'Running pnpm install...'
Push-Location $InstallDir
try {
  pnpm install --frozen-lockfile 2>$null | Out-Null
} finally { Pop-Location }
ok 'Dependencies installed'

# Register selfclaude.cmd
info 'Registering selfclaude command...'

$launcherMjs = Join-Path $InstallDir 'packages\cli\selfclaude.mjs'
$launcherCwd = Split-Path $launcherMjs -Parent
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { $nodeExe = "$env:SystemRoot\node.exe" }

# Link dir: prefer %LOCALAPPDATA%\npm, else create a custom Programs folder
$linkDir = $null
$npmBin = "$env:LOCALAPPDATA\npm"
if (Test-Path $npmBin) {
  $linkDir = $npmBin
} else {
  $linkDir = "$env:USERPROFILE\AppData\Local\Programs\selfclaude\bin"
  if (-not (Test-Path $linkDir)) {
    New-Item -ItemType Directory -Path $linkDir -Force | Out-Null
  }
}

$linkTarget = Join-Path $linkDir 'selfclaude.cmd'

# Build the .cmd wrapper content line by line to avoid PowerShell quoting
# issues with double-quoted strings that contain escaped quotes.
$line1 = '@echo off'
$line2 = "pushd `"$launcherCwd`""
$line3 = "`"$nodeExe`" `"$launcherMjs`" %*"
$line4 = 'popd'
$cmdContent = "$line1`r`n$line2`r`n$line3`r`n$line4"

$cmdContent | Set-Content -Path $linkTarget -Encoding ASCII -NoNewline
ok "selfclaude.cmd registered at $linkTarget"

# Add linkDir to User PATH if not already there
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$linkDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$linkDir;$userPath", 'User')
  warn "$linkDir added to User PATH. Restart your terminal to use selfclaude."
}

Write-Host ''
Write-Host '------------------------------------------------' -ForegroundColor DarkGray
Write-Host ''

Write-Host 'Install complete.' -ForegroundColor Green
Write-Host ''
Write-Host '  Start the daemon:'
Write-Host '    selfclaude start' -ForegroundColor White
Write-Host ''
Write-Host '  Web UI: http://127.0.0.1:3000/' -ForegroundColor Cyan
Write-Host ''
Write-Host '  Commands:'
Write-Host '    selfclaude status    check if running'
Write-Host '    selfclaude restart   reload code'
Write-Host '    selfclaude logs      tail logs'
Write-Host '    selfclaude stop      graceful shutdown'
Write-Host ''
Write-Host '  Optional:'
Write-Host '    Telegram:  selfclaude link-telegram'
Write-Host '    Chrome:    https://claude.ai/chrome'
Write-Host ''
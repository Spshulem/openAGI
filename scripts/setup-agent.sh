#!/usr/bin/env sh
# Hand OpenAGI setup to the person's coding agent (Claude Code or Codex), or
# print the manual steps. Called by scripts/install.sh after an install, and
# safe to run on its own at any time:
#
#   sh scripts/setup-agent.sh                    # ask what to do (needs a terminal)
#   sh scripts/setup-agent.sh --agent claude --install --launch
#   sh scripts/setup-agent.sh --non-interactive  # print the manual path only
#
# What it does, only with the person's explicit yes (a prompt answer or a flag):
#   1. copies the versioned skill in skills/openagi-setup/ to
#      ~/.claude/skills/openagi-setup and/or ~/.codex/skills/openagi-setup;
#   2. writes ~/.openagi-setup/HANDOFF.md (install facts, NO secrets);
#   3. opens the chosen agent in ~/.openagi-setup with a short prompt that
#      names those files.
#
# What it never does: read or pass a key/token, sign anyone in, pass an
# approval- or sandbox-bypass flag to an agent, or replace an existing skill
# that differs without --force or an explicit "yes" (a timestamped backup is
# kept either way).
set -eu

SKILL_NAME="openagi-setup"
SKILL_FILES="SKILL.md adapters/claude-code.md adapters/codex.md adapters/manual.md"
SKILL_REF="${OPENAGI_SKILL_REF:-main}"
SKILL_BASE_URL="${OPENAGI_SKILL_BASE_URL:-https://raw.githubusercontent.com/Spshulem/openAGI/${SKILL_REF}/skills/${SKILL_NAME}}"
SETUP_HOME="${OPENAGI_SETUP_HOME:-${HOME}/.openagi-setup}"
CLAUDE_SKILLS_DIR="${OPENAGI_CLAUDE_SKILLS_DIR:-${HOME}/.claude/skills}"
CODEX_SKILLS_DIR="${OPENAGI_CODEX_SKILLS_DIR:-${CODEX_HOME:-${HOME}/.codex}/skills}"
TTY_PATH="${OPENAGI_SETUP_TTY:-/dev/tty}"

AGENT="auto"
DO_INSTALL=""
DO_LAUNCH=""
FORCE=""
INTERACTIVE="auto"
INSTALL_MODE="unknown"
INSTALL_DIR=""
SKILL_SRC=""
FROM_DOWNLOAD=""

say() { printf '%s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*"; }

usage() {
  cat <<'EOF'
usage: setup-agent.sh [--agent auto|claude|codex|manual] [--install] [--launch]
                      [--force] [--non-interactive] [--install-mode MODE]
                      [--install-dir DIR] [--skill-src DIR] [--from-download]
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --agent) AGENT="${2:-}"; shift 2 ;;
    --install) DO_INSTALL=1; shift ;;
    --launch) DO_LAUNCH=1; DO_INSTALL=1; shift ;;
    --force) FORCE=1; shift ;;
    --non-interactive) INTERACTIVE=0; shift ;;
    --install-mode) INSTALL_MODE="${2:-unknown}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --skill-src) SKILL_SRC="${2:-}"; shift 2 ;;
    --from-download) FROM_DOWNLOAD=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

case "$AGENT" in auto|claude|codex|manual) ;; *) usage >&2; exit 2 ;; esac
case "$INSTALL_MODE" in mac|docker|systemd|source|portable|unknown) ;; *) INSTALL_MODE="unknown" ;; esac
[ "${OPENAGI_NONINTERACTIVE:-0}" = "1" ] && INTERACTIVE=0

# Interactive only when a real terminal can be opened. `curl … | sh` gives the
# script the pipe as stdin, so prompts read the terminal directly. fd 3 stays
# open so a sequence of answers is read in order.
if [ "$INTERACTIVE" = "auto" ]; then
  # Probe in a subshell first: a failed `exec` redirection exits a POSIX sh.
  if [ -r "$TTY_PATH" ] && (: <"$TTY_PATH") 2>/dev/null; then
    exec 3<"$TTY_PATH"; INTERACTIVE=1
  else
    INTERACTIVE=0
  fi
elif [ "$INTERACTIVE" = "1" ]; then
  exec 3<"$TTY_PATH"
fi

# ask "question" default(y|n) → 0 for yes. Never "yes" without a terminal.
ask() {
  [ "$INTERACTIVE" = "1" ] || return 1
  if [ "$2" = "y" ]; then hint="[Y/n]"; else hint="[y/N]"; fi
  printf '%s %s ' "$1" "$hint" >&2
  answer=""
  IFS= read -r answer <&3 || answer=""
  case "$answer" in
    [Yy]|[Yy][Ee][Ss]) return 0 ;;
    "") [ "$2" = "y" ] ;;
    *) return 1 ;;
  esac
}

# --- the skill files -------------------------------------------------------

SCRIPT_DIR=""
case "$0" in */*) SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || true)" ;; esac
if [ -z "$SKILL_SRC" ] && [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/../skills/$SKILL_NAME/SKILL.md" ]; then
  SKILL_SRC="$SCRIPT_DIR/../skills/$SKILL_NAME"
fi
STAGE=""
cleanup() { [ -n "$STAGE" ] && rm -rf "$STAGE"; return 0; }
trap cleanup EXIT
trap 'exit 130' INT TERM

stage_skill() {
  STAGE="$(mktemp -d)"
  if [ -n "$SKILL_SRC" ]; then
    for f in $SKILL_FILES; do
      [ -f "$SKILL_SRC/$f" ] || { warn "Skill source is missing $f ($SKILL_SRC)."; return 1; }
      mkdir -p "$STAGE/$(dirname "$f")"
      cp "$SKILL_SRC/$f" "$STAGE/$f"
    done
    return 0
  fi
  command -v curl >/dev/null 2>&1 || { warn "curl is needed to download the setup skill."; return 1; }
  for f in $SKILL_FILES; do
    mkdir -p "$STAGE/$(dirname "$f")"
    if ! curl -fsSL --proto '=https' "$SKILL_BASE_URL/$f" -o "$STAGE/$f"; then
      warn "Couldn't download $f from $SKILL_BASE_URL."
      return 1
    fi
  done
  # A download that isn't our skill (captive portal, error page) stops here.
  grep -q "^name: $SKILL_NAME\$" "$STAGE/SKILL.md" || { warn "Downloaded SKILL.md is not the $SKILL_NAME skill; not installing it."; return 1; }
}

skill_version() {
  sed -n 's/^[[:space:]]*version:[[:space:]]*\([0-9][0-9A-Za-z.+-]*\)[[:space:]]*$/\1/p' "$1/SKILL.md" 2>/dev/null | head -1
}

same_skill() {
  [ -d "$1" ] && [ ! -L "$1" ] || return 1
  for f in $SKILL_FILES; do cmp -s "$STAGE/$f" "$1/$f" || return 1; done
}

# install_skill <parent-dir> <label> → 0 when the skill is in place afterwards.
install_skill() {
  target="$1/$SKILL_NAME"
  new_v="$(skill_version "$STAGE")"
  if same_skill "$target"; then
    note "✓ $2 skill already installed and current (v${new_v}): $target"
    return 0
  fi
  if [ -e "$target" ] || [ -L "$target" ]; then
    old_v="$(skill_version "$target" || true)"
    say "  A different $SKILL_NAME skill is already at $target (v${old_v:-unknown}; this one is v${new_v})."
    if [ -z "$FORCE" ] && ! ask "  Replace it? The current one is kept as a backup." n; then
      note "Left it unchanged. Rerun with --force to replace it (a backup is kept)."
      return 1
    fi
    backup="$target.bak-$(date +%Y%m%d%H%M%S)"
    mv "$target" "$backup"
    note "Backed up the previous skill to $backup"
  fi
  mkdir -p "$target"
  for f in $SKILL_FILES; do
    mkdir -p "$target/$(dirname "$f")"
    cp "$STAGE/$f" "$target/$f"
  done
  note "✓ Installed the $2 skill (v${new_v}) at $target"
}

# --- handoff context (facts only, never secrets) ---------------------------

cli_hint() {
  case "$INSTALL_MODE" in
    mac) printf '%s' '"/Applications/OpenAGI.app/Contents/Resources/node/bin/node" "/Applications/OpenAGI.app/Contents/Resources/openAGI/bin/openagi.js"' ;;
    docker) printf '%s' 'docker exec openagi node bin/openagi.js' ;;
    systemd|source) printf 'node %s/bin/openagi.js' "${INSTALL_DIR:-/opt/openagi}" ;;
    *) printf '%s' 'see "Find the CLI" in SKILL.md' ;;
  esac
}

write_handoff() {
  mkdir -p "$SETUP_HOME"
  chmod 700 "$SETUP_HOME" 2>/dev/null || true
  {
    printf '# OpenAGI setup handoff\n\n'
    printf 'Written by scripts/setup-agent.sh at %s. Contains no secrets; do not add any.\n\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf -- '- Skill: %s v%s\n' "$SKILL_NAME" "$(skill_version "$STAGE")"
    printf -- '- Install mode: %s\n' "$INSTALL_MODE"
    [ -n "$INSTALL_DIR" ] && printf -- '- Install directory: %s\n' "$INSTALL_DIR"
    printf -- '- OS / arch: %s\n' "$(uname -sm 2>/dev/null || echo unknown)"
    printf -- '- OpenAGI CLI: %s\n' "$(cli_hint)"
    printf -- '- Dashboard on this machine: http://127.0.0.1:43210/ (setup page: /setup)\n'
    [ "$INSTALL_MODE" = "docker" ] && printf -- '- Docker: the installer printed a one-time sign-in URL to the person. Do not ask for it.\n'
    printf -- '- Skill files: %s\n' "$SETUP_HOME/skill/SKILL.md"
    printf '\nStart with step 1 of SKILL.md. The person runs every sign-in themselves.\n'
  } > "$SETUP_HOME/HANDOFF.md"
  rm -rf "$SETUP_HOME/skill"
  mkdir -p "$SETUP_HOME/skill"
  for f in $SKILL_FILES; do
    mkdir -p "$SETUP_HOME/skill/$(dirname "$f")"
    cp "$STAGE/$f" "$SETUP_HOME/skill/$f"
  done
}

handoff_prompt() {
  # $1 = adapter name. Paths and instructions only: no tokens, keys or URLs
  # that carry credentials. The agent reads the rest from disk.
  printf 'Help me finish setting up OpenAGI on this computer using the openagi-setup skill. Read %s and %s, then %s, and follow them one step at a time. Ask before changing anything. Never ask me for an API key or token. I will run any sign-in commands myself.' \
    "$1/SKILL.md" "$1/adapters/$2.md" "$SETUP_HOME/HANDOFF.md"
}

rerun_hint() {
  if [ -z "$FROM_DOWNLOAD" ] && [ -n "$SCRIPT_DIR" ]; then
    printf 'sh %s/setup-agent.sh' "$SCRIPT_DIR"
  else
    printf 'curl -fsSL https://raw.githubusercontent.com/Spshulem/openAGI/%s/scripts/setup-agent.sh -o setup-agent.sh && sh setup-agent.sh' "$SKILL_REF"
  fi
}

print_manual() {
  say ""
  say "Finish setup by hand (or in any coding agent):"
  note "Guide:    $SETUP_HOME/skill/adapters/manual.md"
  note "CLI:      $(cli_hint)"
  note "Check:    <CLI> doctor   then   <CLI> provider"
  note "Browser:  http://127.0.0.1:43210/setup on the OpenAGI machine"
  note "Later, to hand setup to Claude Code or Codex:"
  note "          $(rerun_hint)"
}

launch_agent() {
  # $1 = claude|codex, $2 = installed skill dir
  adapter="claude-code"; [ "$1" = "codex" ] && adapter="codex"
  prompt="$(handoff_prompt "$2" "$adapter")"
  say ""
  say "Opening $1 in $SETUP_HOME with the setup context."
  note "It uses its normal permission prompts; approve each step yourself."
  # cwd is the handoff folder, never the data directory (.env) or $HOME.
  # Default permission mode: no skip-permissions / full-auto / bypass flags.
  if [ "$INTERACTIVE" = "1" ]; then
    (cd "$SETUP_HOME" && "$1" "$prompt" <"$TTY_PATH") || warn "$1 exited with an error. Rerun: cd $SETUP_HOME && $1"
  else
    (cd "$SETUP_HOME" && "$1" "$prompt") || warn "$1 exited with an error. Rerun: cd $SETUP_HOME && $1"
  fi
}

# --- main ------------------------------------------------------------------

say ""
say "── Guided setup with a coding agent ─────────────────"

if [ "$(id -u)" -eq 0 ] && [ "${OPENAGI_SETUP_ALLOW_ROOT:-0}" != "1" ]; then
  say "Running as root, so no agent skill was installed (it belongs in your own home folder)."
  note "As your normal user, run:  $(rerun_hint)"
  exit 0
fi

if ! stage_skill; then
  say "Guided setup files are unavailable, so nothing was installed."
  note "Finish in the browser: http://127.0.0.1:43210/setup"
  note "Or follow docs/INSTALL.md (\"Guided setup with a coding agent\")."
  exit 0
fi
VERSION="$(skill_version "$STAGE")"

HAS_CLAUDE=""; command -v claude >/dev/null 2>&1 && HAS_CLAUDE=1
HAS_CODEX="";  command -v codex  >/dev/null 2>&1 && HAS_CODEX=1

# Resolve which agent(s) to set up.
case "$AGENT" in
  claude) [ -n "$HAS_CLAUDE" ] || { warn "Claude Code (claude) isn't on PATH."; AGENT="manual"; } ;;
  codex)  [ -n "$HAS_CODEX" ]  || { warn "Codex (codex) isn't on PATH."; AGENT="manual"; } ;;
esac

if [ "$AGENT" = "auto" ]; then
  if [ -z "$HAS_CLAUDE" ] && [ -z "$HAS_CODEX" ]; then
    say "No Claude Code or Codex CLI found on PATH."
    AGENT="manual"
  elif [ "$INTERACTIVE" = "1" ] && [ -z "$DO_INSTALL" ]; then
    say "OpenAGI can install a setup skill (v$VERSION) so your coding agent can walk"
    say "you through sign-in, configuration and a real test. Nothing is changed"
    say "without your yes, and no keys or tokens are passed to the agent."
    if [ -n "$HAS_CLAUDE" ] && [ -n "$HAS_CODEX" ]; then
      printf 'Use which agent? [1] Claude Code  [2] Codex  [3] Both (skill only)  [Enter] skip: ' >&2
      choice=""; IFS= read -r choice <&3 || choice=""
      case "$choice" in 1) AGENT="claude" ;; 2) AGENT="codex" ;; 3) AGENT="both" ;; *) AGENT="manual" ;; esac
    elif [ -n "$HAS_CLAUDE" ]; then
      if ask "Install the OpenAGI setup skill for Claude Code?" n; then AGENT="claude"; else AGENT="manual"; fi
    else
      if ask "Install the OpenAGI setup skill for Codex?" n; then AGENT="codex"; else AGENT="manual"; fi
    fi
    [ "$AGENT" != "manual" ] && DO_INSTALL=1
  elif [ -n "$DO_INSTALL" ]; then
    AGENT="detected"
  else
    AGENT="manual"
  fi
elif [ "$AGENT" != "manual" ] && [ -z "$DO_INSTALL" ]; then
  if ask "Install the OpenAGI setup skill (v$VERSION) for $AGENT?" n; then DO_INSTALL=1; else AGENT="manual"; fi
fi

write_handoff

if [ "$AGENT" = "manual" ] || [ -z "$DO_INSTALL" ]; then
  print_manual
  exit 0
fi

INSTALLED_CLAUDE=""; INSTALLED_CODEX=""
if { [ "$AGENT" = "claude" ] || [ "$AGENT" = "both" ] || { [ "$AGENT" = "detected" ] && [ -n "$HAS_CLAUDE" ]; }; }; then
  install_skill "$CLAUDE_SKILLS_DIR" "Claude Code" && INSTALLED_CLAUDE=1 || true
fi
if { [ "$AGENT" = "codex" ] || [ "$AGENT" = "both" ] || { [ "$AGENT" = "detected" ] && [ -n "$HAS_CODEX" ]; }; }; then
  install_skill "$CODEX_SKILLS_DIR" "Codex" && INSTALLED_CODEX=1 || true
fi

# Launch only for a single, chosen agent, and only on an explicit yes/flag.
LAUNCH_AGENT=""; LAUNCH_DIR="$SETUP_HOME/skill"
if [ "$AGENT" = "claude" ]; then LAUNCH_AGENT="claude"; [ -n "$INSTALLED_CLAUDE" ] && LAUNCH_DIR="$CLAUDE_SKILLS_DIR/$SKILL_NAME"; fi
if [ "$AGENT" = "codex" ]; then LAUNCH_AGENT="codex"; [ -n "$INSTALLED_CODEX" ] && LAUNCH_DIR="$CODEX_SKILLS_DIR/$SKILL_NAME"; fi

if [ -n "$LAUNCH_AGENT" ]; then
  if [ -n "$DO_LAUNCH" ] || ask "Open $LAUNCH_AGENT now to finish setup?" n; then
    launch_agent "$LAUNCH_AGENT" "$LAUNCH_DIR"
    exit 0
  fi
  say ""
  say "When you're ready, run:"
  note "cd $SETUP_HOME && $LAUNCH_AGENT"
  note "then ask it: \"finish setting up OpenAGI\" (the skill and HANDOFF.md are there)."
elif [ -n "$INSTALLED_CLAUDE$INSTALLED_CODEX" ]; then
  say ""
  say "When you're ready, start your agent in $SETUP_HOME and ask it to"
  say "\"finish setting up OpenAGI\" (the skill and HANDOFF.md are there):"
  [ -n "$INSTALLED_CLAUDE" ] && note "cd $SETUP_HOME && claude"
  [ -n "$INSTALLED_CODEX" ] && note "cd $SETUP_HOME && codex"
  :
else
  print_manual
fi

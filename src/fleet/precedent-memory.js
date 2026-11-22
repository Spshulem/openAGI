// Historical Owner-Decision Precedent Engine for the OpenAGI Fleet Supervisor.
//
// Captures every owner decision (card answers, typed replies, Supervisor directives,
// and backfilled FleetStore question history) under <dataDir>/fleet/precedents.json,
// retrieves matching historical precedents before stopping or escalating to Needs You,
// scores semantic confidence via OpenAI `/v1/decisions` (>= 0.85), and enforces an
// unconditional Hard Red-Line Firewall (never auto-merging PRs, deploying to prod,
// messaging external customers/teammates, spending money, deleting shared data, or
// bypassing human SSO/2FA logins).

import crypto from "node:crypto";
import path from "node:path";
import { ensureDir, readJsonFile, writeJsonAtomic } from "../file-utils.js";
import { clampTail, clampText, redactSecrets, shortHash } from "./contracts.js";
import {
  DEFAULT_DECISIONS_MODEL,
  DEFAULT_DECISIONS_TIMEOUT_MS,
  DEFAULT_DECISIONS_URL,
  callDecisionsEndpoint
} from "./decisions-gate.js";

const PRECEDENTS_FILE = "precedents.json";
const MAX_PRECEDENTS = 500;
const MAX_APPLICATIONS = 200;
export const DEFAULT_PRECEDENT_CONFIDENCE_THRESHOLD = 0.85;

// Hard Red-Line Firewall: NEVER crossed automatically, even at 1.00 confidence.
export const HARD_RED_LINE_RULES = Object.freeze([
  {
    id: "pr_merge",
    label: "PR merge requires explicit owner review",
    pattern: /\b(?:gh\s+pr\s+merge|merge\s+(?:this\s+|the\s+|both\s+|all\s+)?(?:prs?|pull\s+requests?|#\d+|branch(?:es)?|stack|into\s+main|to\s+main)|admin[- ]merge|--admin)\b/i
  },
  {
    id: "prod_deploy_or_release",
    label: "Production deploy or public store release requires owner sign-off",
    pattern: /\b(?:deploy\s+(?:to\s+)?prod(?:uction)?|promote\s+to\s+prod(?:uction)?|release\s+to\s+prod(?:uction)?|submit\s+(?:build\s+|app\s+)?for\s+(?:app\s+store\s+)?review|publish\s+release\s+to\s+production|live\s+(?:db|database)\s+migration)\b/i
  },
  {
    id: "external_customer_or_team_send",
    label: "External customer/team outreach or public publishing requires owner approval",
    pattern: /\b(?:send\s+(?:the\s+|this\s+|a\s+)?(?:follow[- ]?up\s+|draft\s+|customer\s+)?(?:email|message|slack|telegram|report|link|reply)\s+to\s+(?!the\s+(?:coding|agent|session|paseo)|paseo\b)[A-Za-z@][A-Za-z0-9_.-]*|publish\s+(?:to\s+|on\s+|the\s+\d+\s+)?(?:youtube|cms|ghost|webflow|blog|x\b|twitter|linkedin)|upload\s+to\s+youtube)\b/i
  },
  {
    id: "paid_spend",
    label: "Spending money or changing ad budgets requires owner approval",
    pattern: /\b(?:purchase\s+more\s+credits|buy\s+credits|charge\s+(?:the\s+)?card|increase\s+ad\s+(?:spend|budget)|launch\s+paid\s+campaign|upgrade\s+(?:your\s+|the\s+)?plan)\b/i
  },
  {
    id: "destructive_delete",
    label: "Destructive deletes or history rewrites require owner approval",
    pattern: /\b(?:drop\s+table|truncate\s+table|delete\s+from\b|rm\s+-rf\s+(?:\/|~|\$HOME)|git\s+push\b[^\n]*--force|git\s+reset\s+--hard\s+origin)\b/i
  },
  {
    id: "human_sso_or_2fa",
    label: "Interactive human SSO / OAuth / 2FA login requires owner presence",
    pattern: /\b(?:complete\s+(?:vercel\s+|google\s+|github\s+|okta\s+)?sso|sign\s+in\s+(?:to|with|for)\s+(?:@?[A-Za-z0-9_.-]+|google|vercel|apple)|2fa\s+code|two[- ]factor|enter\s+your\s+password|shared\s+browser\s+tab)\b/i
  }
]);

const SAFE_READONLY_BINS = new Set([
  "rg", "grep", "egrep", "fgrep", "cat", "head", "tail", "wc", "ls", "pwd", "echo", "printf",
  "which", "stat", "file", "jq", "cut", "sort", "uniq", "tr", "basename", "dirname", "realpath",
  "df", "du", "ps", "uname", "sw_vers"
]);

const DANGEROUS_ENV_VARS = /^(?:PATH|LD_[A-Z0-9_]*|DYLD_[A-Z0-9_]*|NODE_OPTIONS|BASH_ENV|ENV|PROMPT_COMMAND|GIT_SSH_COMMAND|GIT_EXEC_PATH|GIT_EXTERNAL_DIFF|PYTHONPATH|RUBYOPT|PERL5OPT)=/i;

const SENSITIVE_COMMAND_PATHS = /(?:^|[\s"'=/])(?:\.env(?:\.[A-Za-z0-9_.-]+)?|\.ssh\/|id_rsa|id_ed25519|credentials\.json|auth\.json|keychain|secrets?\b|\.npmrc|\.netrc|\.pypirc)(?:$|[\s"'/])/i;

function stripSafeStderrRedirects(input) {
  let out = "";
  let quote = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === "\\" && quote === "\"" && i + 1 < input.length) {
        out += ch + input[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      out += ch;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      out += ch;
      continue;
    }
    const rest = input.slice(i);
    const prevOk = i === 0 || /[\s;|&]/.test(input[i - 1]);
    if (prevOk) {
      const m = /^(?:2>\/dev\/null|2>&1)(?=$|[\s;|&])/.exec(rest);
      if (m) {
        out += " ";
        i += m[0].length - 1;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function isSafeShellVarAssignment(token) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*=[^;&|<>`$()\n]*$/.test(token)) return false;
  if (DANGEROUS_ENV_VARS.test(token)) return false;
  if (SENSITIVE_COMMAND_PATHS.test(token)) return false;
  return true;
}

function hasUnquotedShellHazard(input) {
  let quote = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === "\\" && quote === "\"" && i + 1 < input.length) {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      // Backticks or $(...) inside double quotes execute in bash!
      if (quote === "\"" && (ch === "`" || (ch === "$" && input[i + 1] === "("))) return true;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    // An unquoted newline is a command separator the segment parser does not
    // split on; a second command could hide in what looks like arguments.
    if (ch === "`" || ch === "<" || ch === ">" || ch === "\n" || ch === "\r") return true;
    if (ch === "$" && input[i + 1] === "(") return true;
    if (ch === "&" && input[i + 1] !== "&" && input[i - 1] !== "&") return true;
  }
  return Boolean(quote);
}

// Strictly verifies that a shell / CodexBash command string is pure read-only
// repository or GitHub/CI inspection with zero mutation, network exfiltration,
// subshells, file output redirects, or secret-file reads.
export function isSafeReadOnlyCommand(rawCommand) {
  const raw = String(rawCommand ?? "").trim();
  if (!raw || raw.length > 3000) return false;
  // Strip `Run \`...\`` wrapper if formatted from policy.js permWhat before checking backticks.
  const unwrapped = stripSafeStderrRedirects(/^Run\s+`([^`]+)`$/i.exec(raw)?.[1]?.trim() ?? raw);
  // Reject command substitutions, backticks, unquoted redirects/backgrounding, parameter side-effects, or secret paths.
  if (hasUnquotedShellHazard(unwrapped) || /\$\{[^\s}]*:[-=?+]/.test(unwrapped) || SENSITIVE_COMMAND_PATHS.test(unwrapped)) return false;

  const segments = splitShellSegments(unwrapped);
  if (!segments.length || segments.length > 24) return false;

  let sawInspectionCmd = false;
  for (const seg of segments) {
    const tokens = tokenizeSegment(seg);
    if (!tokens.length) return false;
    let idx = 0;
    while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) {
      if (!isSafeShellVarAssignment(tokens[idx])) return false;
      idx += 1;
    }
    // Standalone safe variable assignment segment (e.g. `R=owner/repo; gh api repos/$R/...`).
    if (idx >= tokens.length) continue;
    // A path (./scripts/cat, /tmp/x/cat) can be any program; only bare names
    // resolve to the system utilities this allowlist describes.
    if (!isBareExecutable(tokens[idx])) return false;
    const cmd = tokens[idx];
    const args = tokens.slice(idx + 1);
    if (!isAllowedReadOnlySegment(cmd, args)) return false;
    if (cmd !== "true") sawInspectionCmd = true;
  }
  return sawInspectionCmd;
}

// Strictly verifies a local feature-branch / isolated-worktree `git add` + `git commit`
// or non-force feature-branch `git push -u origin <feature-branch>` (never allowing
// `main`/`master`/`production` pushes, `--force`, `--no-verify`, or history rewrites).
export function isSafeLocalWorktreeCommitCommand(rawCommand, thread = null) {
  const raw = String(rawCommand ?? "").trim();
  if (!raw || raw.length > 3000) return false;
  const unwrapped = stripSafeStderrRedirects(/^Run\s+`([^`]+)`$/i.exec(raw)?.[1]?.trim() ?? raw);
  if (hasUnquotedShellHazard(unwrapped) || /\$\{[^\s}]*:[-=?+]/.test(unwrapped) || SENSITIVE_COMMAND_PATHS.test(unwrapped)) return false;

  const branch = String(thread?.branch ?? "").trim();
  const cwd = String(thread?.meta?.paseoCwd ?? thread?.cwd ?? "").trim();
  if (branch && /^(?:main|master|prod(?:uction)?|release|HEAD)$/i.test(branch)) return false;

  const segments = splitShellSegments(unwrapped);
  if (!segments.length || segments.length > 12) return false;

  let sawLocalCommitStep = false;
  let sawSafeFeaturePush = false;
  for (const seg of segments) {
    const tokens = tokenizeSegment(seg);
    if (!tokens.length) return false;
    let idx = 0;
    while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) {
      if (!isSafeShellVarAssignment(tokens[idx])) return false;
      idx += 1;
    }
    if (idx >= tokens.length) continue;
    if (!isBareExecutable(tokens[idx])) return false;
    const cmd = tokens[idx];
    const args = tokens.slice(idx + 1);
    if (isAllowedReadOnlySegment(cmd, args)) continue;
    if (cmd !== "git") return false;
    // The isolation check is about this thread's own worktree: any option that
    // points git at another repository or rewrites its config is refused.
    if (args.some(isGitRepoOrConfigOverride)) return false;
    let subIdx = 0;
    while (subIdx < args.length && args[subIdx].startsWith("-")) subIdx += 1;
    const sub = args[subIdx] ?? "";
    const subArgs = args.slice(subIdx + 1);
    if (sub === "add") {
      if (!subArgs.length) return false;
      if (subArgs.some((a) => /^-(?:[A-Za-z]*f|-force)$/i.test(a) || a.includes("..") || SENSITIVE_COMMAND_PATHS.test(a))) return false;
      sawLocalCommitStep = true;
      continue;
    }
    if (sub === "commit") {
      if (subArgs.some((a) => /^(?:-n|--no-verify|--amend|--allow-empty-message)$/i.test(a))) return false;
      if (!subArgs.some((a) => /^(?:-m|--message(?:=.*)?)$/i.test(a))) return false;
      sawLocalCommitStep = true;
      continue;
    }
    if (sub === "push") {
      // Allow ONLY non-force push to an explicit non-trunk feature branch (`git push [-u] origin <feature-branch>`).
      if (subArgs.some((a) => /^(?:-f|--force|--force-with-lease|--delete|--mirror|--all|--tags|--no-verify)$/i.test(a) || a.startsWith("+") || a.includes(":"))) return false;
      const positional = subArgs.filter((a) => !["-u", "--set-upstream"].includes(a));
      if (positional.length !== 2 || positional[0] !== "origin") return false;
      const targetBranch = positional[1];
      if (!targetBranch || /^(?:main|master|prod(?:uction)?|staging|develop|release.*|HEAD)$/i.test(targetBranch)) return false;
      sawSafeFeaturePush = true;
      continue;
    }
    return false;
  }
  if (sawSafeFeaturePush && !sawLocalCommitStep) return true;
  const inIsolatedWorktree = Boolean(
    (branch && !/^(?:main|master|prod(?:uction)?|release|HEAD)$/i.test(branch))
    || /\/(?:worktrees|\.conductor)\//i.test(cwd)
  );
  return inIsolatedWorktree && (sawLocalCommitStep || sawSafeFeaturePush);
}

function splitShellSegments(input) {
  const out = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === "\\" && quote === "\"" && i + 1 < input.length) {
        cur += ch + input[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ";") {
      if (!cur.trim()) return [];
      out.push(cur.trim());
      cur = "";
      continue;
    }
    if (ch === "|") {
      if (input[i + 1] === "|") {
        if (!cur.trim()) return [];
        out.push(cur.trim());
        cur = "";
        i += 1;
        continue;
      }
      if (!cur.trim()) return [];
      out.push(cur.trim());
      cur = "";
      continue;
    }
    if (ch === "&" && input[i + 1] === "&") {
      if (!cur.trim()) return [];
      out.push(cur.trim());
      cur = "";
      i += 1;
      continue;
    }
    cur += ch;
  }
  if (quote) return [];
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function tokenizeSegment(seg) {
  const tokens = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < seg.length; i += 1) {
    const ch = seg[i];
    if (quote) {
      if (ch === "\\" && quote === "\"" && i + 1 < seg.length) {
        cur += seg[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur.length > 0) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) tokens.push(cur);
  return tokens;
}

function isBareExecutable(token) {
  return /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(String(token ?? ""));
}

function isGitRepoOrConfigOverride(arg) {
  return /^(?:-C|-c|--git-dir(?:=.*)?|--work-tree(?:=.*)?|--namespace(?:=.*)?|--exec-path(?:=.*)?|--config-env(?:=.*)?)$/.test(arg)
    || /^-[Cc].+/.test(arg);
}

// Short-option clusters ("-uo", "-no") still carry the flag.
function hasShortFlag(args, letter) {
  return args.some((a) => /^-[A-Za-z]+$/.test(a) && !a.startsWith("--") && a.slice(1).includes(letter));
}

// Options that make an otherwise read-only utility write files or run
// another program.
const MUTATING_OPTIONS = {
  sort: (args) => hasShortFlag(args, "o") || args.some((a) => /^--(?:output|compress-program)(?:=|$)/.test(a)),
  // `uniq IN OUT` writes OUT.
  uniq: (args) => args.filter((a) => !a.startsWith("-")).length > 1,
  rg: (args) => args.some((a) => /^--pre(?:-glob)?(?:=|$)/.test(a)),
  file: (args) => hasShortFlag(args, "C") || args.some((a) => /^--compile$/.test(a)),
  tail: (args) => hasShortFlag(args, "f") || hasShortFlag(args, "F") || args.some((a) => /^--(?:follow|retry)/.test(a))
};

// sed is allowed only to print: `-n` with p-only scripts such as `1,20p`,
// `$p`, or `/re/p`; no w/W (write), e (execute), or script files.
function isPrintOnlySedScript(script) {
  return String(script ?? "").split(/\s*;\s*/).every((part) => /^(?:\d+|\$|\/[^/]*\/)?(?:,(?:\d+|\$|\/[^/]*\/))?p$/.test(part.trim()));
}

function isAllowedReadOnlySegment(cmd, args) {
  if (cmd === "true") return args.length === 0;
  if (SAFE_READONLY_BINS.has(cmd)) {
    return !(MUTATING_OPTIONS[cmd]?.(args));
  }
  if (cmd === "sed") {
    if (args.some((a) => /^-(?:[A-Za-z]*[if]|-in-place|-file)/i.test(a))) return false;
    if (!args.includes("-n")) return false;
    const scripts = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "-e" || args[i] === "--expression") { scripts.push(args[i + 1]); i += 1; continue; }
      if (/^--expression=/.test(args[i])) { scripts.push(args[i].slice(13)); continue; }
      if (args[i].startsWith("-")) continue;
      if (!scripts.length) scripts.push(args[i]);
    }
    return scripts.length > 0 && scripts.every(isPrintOnlySedScript);
  }
  if (cmd === "find") {
    if (args.some((a) => /^-(?:delete|exec|execdir|ok|okdir|fls|fprint|fprint0|fprintf)$/i.test(a))) return false;
    return true;
  }
  if (cmd === "git") {
    if (args.some(isGitRepoOrConfigOverride)) return false;
    // --output writes a file; -O / --open-files-in-pager runs a program;
    // --ext-diff runs a configured external diff.
    if (args.some((a) => /^(?:--output(?:=|$)|-O.*|--open-files-in-pager(?:=|$)|--ext-diff$)/.test(a))) return false;
    let subIdx = 0;
    while (subIdx < args.length && args[subIdx].startsWith("-")) subIdx += 1;
    const sub = args[subIdx] ?? "";
    if (!["status", "log", "diff", "show", "rev-parse", "branch", "ls-files", "grep", "blame"].includes(sub)) {
      return false;
    }
    if (sub === "branch") {
      return args.slice(subIdx + 1).every((a) => ["--show-current", "-a", "-r", "-v", "-vv", "--list"].includes(a));
    }
    return true;
  }
  if (cmd === "gh") {
    const [group, action, ...rest] = args;
    if (group === "pr" && ["view", "checks", "list", "status", "diff"].includes(action)) return true;
    if (group === "run" && ["view", "list"].includes(action)) return true;
    if (group === "issue" && ["view", "list", "status"].includes(action)) return true;
    if (group === "api") {
      if (rest.some((a) => /^(?:-X|--method|-f|-F|--field|--raw-field|--input)$/i.test(a))) return false;
      if (rest.some((a) => /mutation\b/i.test(a))) return false;
      return true;
    }
    return false;
  }
  if (cmd === "paseo") {
    return ["ls", "list", "status", "version", "--version"].includes(args[0] ?? "");
  }
  if (cmd === "curl") {
    if (args.some((a) => /^(?:-X|--request|-d|--data.*|-F|--form.*|-T|--upload-file|-o|--output|-O|--remote-name|-K|--config)$/i.test(a))) return false;
    const urls = args.filter((a) => /^https?:\/\//i.test(a));
    return urls.length === 1 && /^https:\/\/api\.github\.com\//i.test(urls[0]);
  }
  return false;
}

export function checkHardRedLine(candidate = {}) {
  const kind = String(candidate.kind ?? "").toLowerCase();
  if (kind === "ready" || candidate.mergeAsk === true) {
    return { blocked: true, id: "pr_merge", label: "PR merge requires explicit owner review" };
  }
  const combined = [
    candidate.title,
    candidate.body,
    candidate.command,
    candidate.askContext,
    ...(Array.isArray(candidate.options) ? candidate.options : [])
  ]
    .filter(Boolean)
    .join(" ");

  for (const rule of HARD_RED_LINE_RULES) {
    if (rule.pattern.test(combined)) {
      return { blocked: true, id: rule.id, label: rule.label };
    }
  }
  return { blocked: false, id: null, label: null };
}

export const BUILTIN_OWNER_PRECEDENTS = Object.freeze([
  {
    id: "prec_readonly_bash",
    category: "readonly_inspection",
    repo: "*",
    project: "*",
    patternSummary: "Read-only repository, git, or GitHub PR/CI inspection commands (`rg`, `sed -n`, `git status/log/diff`, `gh pr view/checks`)",
    ownerRule: "Always allow read-only codebase and GitHub CI inspection without interrupting the owner.",
    action: "answer",
    answer: "Allow",
    directive: null,
    approvalCount: 8,
    vetoCount: 0,
    builtIn: true
  },
  {
    id: "prec_main_is_red",
    category: "main_health_recovery",
    repo: "*",
    project: "*",
    patternSummary: "Open PR or coding session stopped only because `main` / `main-health` is red",
    ownerRule: "Spencer's rule: 'main is red' is never a passive stop condition. Get `main` green, then merge `origin/main` into blocked branches and re-verify until ready for merge review.",
    action: "nudge",
    answer: null,
    directive: "Owner precedent: a red `main` / `main-health` check is not a reason to stop indefinitely. Check whether `main` has already been repaired on `origin/main`; if `origin/main` is newer or green, merge `origin/main` into your branch and re-run required verification. If `main` itself still has a failing check and no active `fix-main` PR is open, diagnose the exact `main` failure in scope.",
    approvalCount: 5,
    vetoCount: 0,
    builtIn: true
  },
  {
    id: "prec_appfolio_staging_mcp",
    category: "mcp_environment_routing",
    repo: "buildbetter-app/buildbetter",
    project: "buildbetter",
    patternSummary: "AppFolio Lifecycles / Rubric report blocked on production BuildBetter MCP workspace missing AppFolio",
    ownerRule: "Spencer's rule: AppFolio reports must NOT depend on production MCP — the staging MCP (`buildbetter-staging`) manages AppFolio's MCP and reports.",
    action: "nudge",
    answer: null,
    directive: "Owner directive & precedent: AppFolio Lifecycles reports do NOT need production MCP. Use the staging MCP (`buildbetter-staging`) to manage and update AppFolio's MCP and generate/update the AppFolio Lifecycles report. Verify every section of the generated report URL has real data with zero 'not scored' / 'not tested' gaps, then share the verified link for review (do not send externally to the customer without explicit owner sign-off).",
    approvalCount: 3,
    vetoCount: 0,
    builtIn: true
  },
  {
    id: "prec_testflight_export_compliance",
    category: "testflight_compliance",
    repo: "*",
    project: "*",
    patternSummary: "Uploaded iOS/macOS build in App Store Connect is VALID but stuck on `MISSING_EXPORT_COMPLIANCE`",
    ownerRule: "Clear standard HTTPS/TLS export compliance (`ITSAppUsesNonExemptEncryption=NO` / App Store Connect encryption declaration) automatically so TestFlight builds become installable; hold only before public App Store release submission.",
    action: "nudge",
    answer: null,
    directive: "Owner precedent: do not stop at reporting `MISSING_EXPORT_COMPLIANCE` on a TestFlight build. Set `ITSAppUsesNonExemptEncryption` to `NO` (standard HTTPS/OS encryption only) in Info.plist and/or clear the export-compliance declaration via the App Store Connect API so the TestFlight build distributes immediately, then verify the build reaches Ready to Test. Stop before submitting a public App Store release.",
    approvalCount: 3,
    vetoCount: 0,
    builtIn: true
  },
  {
    id: "prec_stream_disconnect_retry",
    category: "transient_disconnect",
    repo: "*",
    project: "*",
    patternSummary: "Session interrupted by `stream disconnected before completion` or transient transport timeout",
    ownerRule: "Automatically resume interrupted turns from current workspace git state instead of leaving the project stalled.",
    action: "nudge",
    answer: null,
    directive: "Your previous turn was interrupted by a transient stream disconnect before completion. Check `git status` and recent changes in this workspace first, then continue and verify the unfinished in-scope work.",
    approvalCount: 4,
    vetoCount: 0,
    builtIn: true
  },
  {
    id: "prec_local_worktree_commit",
    category: "local_worktree_commit",
    repo: "*",
    project: "*",
    patternSummary: "Local isolated feature-branch / worktree `git add` + `git commit` (with hooks enabled, never pushing or touching main)",
    ownerRule: "Allow local feature-branch and worktree commits without interrupting the owner; hold before any merge or production push.",
    action: "answer",
    answer: "Allow",
    directive: null,
    approvalCount: 6,
    vetoCount: 0,
    builtIn: true
  },
  {
    id: "prec_engineering_hygiene",
    category: "engineering_hygiene",
    repo: "*",
    project: "*",
    patternSummary: "Routine reversible local engineering hygiene (rerunning flaky CI once, closing leftover test browser/process, using external scratch disk `/Volumes/Xtra`, creating a clean worktree)",
    ownerRule: "Spencer's rule: never block on routine, reversible local engineering hygiene — rerun flaky CI checks once, close leftover local test browsers/processes spawned for verification, use available scratch disk (/Volumes/Xtra) when root disk is low, and keep pushing until a genuine Hard Red Line (PR merge, prod deploy/release, external customer message, paid spend, destructive delete, or human credentials/SSO/sudo).",
    action: "answer",
    answer: null,
    directive: null,
    approvalCount: 6,
    vetoCount: 0,
    builtIn: true
  }
]);

function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_#/-]+/g, " ")
    .split(/\s+/)
    .filter((tok) => tok.length >= 3);
}

function lexicalSimilarity(queryText, docText) {
  const qTokens = new Set(tokenize(queryText));
  const dTokens = new Set(tokenize(docText));
  if (!qTokens.size || !dTokens.size) return 0;
  let overlap = 0;
  for (const t of qTokens) {
    if (dTokens.has(t)) overlap += 1;
  }
  return overlap / Math.sqrt(qTokens.size * dTokens.size);
}

export class OwnerPrecedentStore {
  constructor({ dir, now = () => Date.now() } = {}) {
    if (!dir) throw new Error("OwnerPrecedentStore requires a directory.");
    this.dir = dir;
    this.file = path.join(dir, PRECEDENTS_FILE);
    this.now = now;
    this.decisionCache = new Map();
    this.state = this._load();
  }

  _load() {
    const raw = readJsonFile(this.file, null);
    const saved = Array.isArray(raw?.precedents) ? raw.precedents : [];
    const byId = new Map();
    for (const builtin of BUILTIN_OWNER_PRECEDENTS) {
      byId.set(builtin.id, { ...builtin, updatedAt: raw?.seededAt ?? new Date(this.now()).toISOString() });
    }
    for (const item of saved) {
      if (!item || typeof item !== "object" || typeof item.id !== "string") continue;
      const existing = byId.get(item.id);
      byId.set(item.id, {
        ...(existing ?? {}),
        id: clampText(item.id, 80),
        category: clampText(item.category || existing?.category || "owner_decision", 60),
        repo: clampText(item.repo || existing?.repo || "*", 120),
        project: clampText(item.project || existing?.project || "*", 80),
        patternSummary: clampText(redactSecrets(item.patternSummary || existing?.patternSummary || ""), 360),
        ownerRule: clampText(redactSecrets(item.ownerRule || existing?.ownerRule || ""), 360),
        action: item.action === "nudge" ? "nudge" : "answer",
        answer: item.answer ? clampText(redactSecrets(item.answer), 120) : null,
        directive: item.directive ? clampText(redactSecrets(item.directive), 600) : null,
        approvalCount: Number.isInteger(item.approvalCount) ? Math.max(0, item.approvalCount) : (existing?.approvalCount ?? 1),
        vetoCount: Number.isInteger(item.vetoCount) ? Math.max(0, item.vetoCount) : (existing?.vetoCount ?? 0),
        builtIn: Boolean(existing?.builtIn || item.builtIn),
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date(this.now()).toISOString()
      });
    }
    return {
      version: 1,
      seededAt: raw?.seededAt ?? new Date(this.now()).toISOString(),
      backfilledCount: Number(raw?.backfilledCount) || 0,
      precedents: [...byId.values()].slice(-MAX_PRECEDENTS),
      applications: Array.isArray(raw?.applications) ? raw.applications.slice(-MAX_APPLICATIONS) : []
    };
  }

  _save() {
    ensureDir(this.dir);
    writeJsonAtomic(this.file, this.state);
  }

  list({ includeVetoed = false, limit = 100 } = {}) {
    return this.state.precedents
      .filter((p) => includeVetoed || (p.vetoCount ?? 0) === 0)
      .slice(-Math.max(1, Math.min(MAX_PRECEDENTS, limit)));
  }

  applications(limit = 30) {
    return this.state.applications.slice(-Math.max(1, Math.min(MAX_APPLICATIONS, limit))).reverse();
  }

  // Ingests answered questions from FleetStore (`state.questions`) so historical
  // owner answers immediately become retrievable precedents without duplicates.
  backfillFromFleetStore(fleetStore) {
    const questions = Array.isArray(fleetStore?.state?.questions) ? fleetStore.state.questions : [];
    let added = 0;
    for (const q of questions) {
      if (!q || q.status !== "answered" || !q.answer) continue;
      if (["dismiss", "later", "skip", "open thread", "got it"].includes(String(q.answer).toLowerCase())) continue;
      if (checkHardRedLine(q).blocked) continue;
      const wasAdded = this.recordOwnerDecision({
        question: q,
        answer: q.answer,
        repo: q.contextSnapshot?.repo ?? null,
        project: q.project ?? q.contextSnapshot?.workspace ?? null,
        at: q.answeredAt ?? q.createdAt ?? null,
        save: false
      });
      if (wasAdded) added += 1;
    }
    if (added > 0) {
      this.state.backfilledCount += added;
      this._save();
    }
    return added;
  }

  recordOwnerDecision({
    question = null,
    answer = null,
    directive = null,
    category = null,
    repo = null,
    project = null,
    at = null,
    save = true
  } = {}) {
    const nowIso = typeof at === "string" && Number.isFinite(Date.parse(at)) ? at : new Date(this.now()).toISOString();
    const candidateCheck = checkHardRedLine({
      kind: question?.kind,
      mergeAsk: question?.mergeAsk,
      title: question?.title,
      body: question?.body ?? directive,
      options: question?.options
    });
    // Never store PR merges or other hard red lines as autonomous precedents.
    if (candidateCheck.blocked) return null;

    const cleanAnswer = answer ? clampText(redactSecrets(String(answer).trim()), 120) : null;
    const cleanDirective = directive ? clampText(redactSecrets(String(directive).trim()), 600) : null;
    if (!cleanAnswer && !cleanDirective) return null;
    if (cleanAnswer && ["dismiss", "later", "skip", "wait", "open thread", "got it"].includes(cleanAnswer.toLowerCase())) {
      return null;
    }

    const summarySource = [question?.title, question?.body, cleanDirective].filter(Boolean).join(" — ");
    const patternSummary = clampText(redactSecrets(summarySource), 340);
    if (!patternSummary || patternSummary.length < 10) return null;

    const normSig = shortHash(`${repo || "*"}|${category || question?.kind || "decision"}|${patternSummary.toLowerCase().slice(0, 140)}|${(cleanAnswer || cleanDirective || "").toLowerCase()}`);
    const id = `prec_${normSig}`;
    const existing = this.state.precedents.find((p) => p.id === id);
    if (existing) {
      existing.approvalCount = (existing.approvalCount ?? 1) + 1;
      existing.updatedAt = nowIso;
      if (save) this._save();
      return existing;
    }

    const entry = {
      id,
      category: clampText(category || question?.kind || "owner_decision", 60),
      repo: clampText(repo || question?.contextSnapshot?.repo || "*", 120),
      project: clampText(project || question?.contextSnapshot?.workspace || "*", 80),
      patternSummary,
      ownerRule: cleanDirective
        ? `Owner directive: ${clampText(cleanDirective, 260)}`
        : `Owner answered "${cleanAnswer}" on: ${clampText(patternSummary, 220)}`,
      action: cleanDirective && !cleanAnswer ? "nudge" : "answer",
      answer: cleanAnswer,
      directive: cleanDirective,
      approvalCount: 1,
      vetoCount: 0,
      builtIn: false,
      updatedAt: nowIso
    };
    this.state.precedents = [...this.state.precedents, entry].slice(-MAX_PRECEDENTS);
    if (save) this._save();
    return entry;
  }

  vetoPrecedent(id) {
    const match = this.state.precedents.find((p) => p.id === id);
    if (!match) return null;
    match.vetoCount = (match.vetoCount ?? 0) + 1;
    match.updatedAt = new Date(this.now()).toISOString();
    this._save();
    return match;
  }

  recordApplication({ precedentId, threadKey, summary, confidence, source }) {
    const entry = {
      id: `papp_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
      precedentId,
      threadKey: threadKey ?? null,
      summary: clampText(redactSecrets(summary), 220),
      confidence: Math.round((Number(confidence) || 0) * 100) / 100,
      source: source ?? "deterministic",
      at: new Date(this.now()).toISOString()
    };
    this.state.applications = [...this.state.applications, entry].slice(-MAX_APPLICATIONS);
    this._save();
    return entry;
  }

  // Evaluates whether an open question or stalled coding session can be resolved
  // autonomously from historical owner precedent with >= 0.85 confidence without
  // crossing any Hard Red Line.
  async evaluateCandidate(
    {
      question = null,
      thread = null,
      pr = null,
      classified = null,
      activeGoal = null
    } = {},
    {
      decisionsConfig = {},
      env = process.env,
      fetchImpl = globalThis.fetch,
      threshold = DEFAULT_PRECEDENT_CONFIDENCE_THRESHOLD
    } = {}
  ) {
    const permCommand = thread?.meta?.pendingPermission?.rawCommand
      ?? thread?.meta?.pendingPermission?.command
      ?? null;
    const redLine = checkHardRedLine({
      kind: question?.kind,
      mergeAsk: question?.mergeAsk,
      title: question?.title,
      body: question?.body,
      options: question?.options,
      command: permCommand,
      askContext: question?.askContext ?? thread?.lastAgentText
    });
    if (redLine.blocked) {
      return { matched: false, hardRedLine: redLine };
    }

    // 1. Deterministic High-Confidence Rule: Read-only shell / CodexBash inspection,
    // isolated feature-worktree commit, or staging MCP read/report tools.
    if (question?.kind === "prompt") {
      const pending = thread?.meta?.pendingPermission ?? null;
      const permName = String(pending?.name ?? "");
      // Only the complete command may be approved by rule: never a display
      // excerpt, the question text, or a command cut short.
      const cmdCandidate = pending?.rawCommand && pending.rawCommandTruncated !== true ? pending.rawCommand : "";
      const isStagingMcpTool = /^mcp__buildbetter-staging__(?:success-(?:search|list|get|create-report|update-report|create-lifecycle|update-lifecycle)|read|search|list|get)/i.test(permName)
        || /\bmcp__buildbetter-staging__/i.test(String(question.title ?? ""));
      const isReadOnlyMcp = /^mcp__[A-Za-z0-9_-]+__(?:search|list|get|read|fetch|query|inspect)[A-Za-z0-9_-]*$/i.test(permName);
      const isReadOnlyCmd = isSafeReadOnlyCommand(cmdCandidate);
      const isLocalCommitCmd = !isReadOnlyCmd && isSafeLocalWorktreeCommitCommand(cmdCandidate, thread);
      if (isReadOnlyCmd || isLocalCommitCmd || isStagingMcpTool || isReadOnlyMcp) {
        const allowOpt = (question.options ?? []).find((opt) => /^(?:allow(?:\s+once|\s+for\s+session|\s+this\s+conversation|\s+always)?|approve(?:\s+once)?|yes)$/i.test(String(opt).trim()));
        const precId = isStagingMcpTool
          ? "prec_appfolio_staging_mcp"
          : (isLocalCommitCmd ? "prec_local_worktree_commit" : "prec_readonly_bash");
        const prec = this.state.precedents.find((p) => p.id === precId);
        if (allowOpt && (!prec || (prec.vetoCount ?? 0) === 0)) {
          return {
            matched: true,
            source: isStagingMcpTool
              ? "deterministic-staging-mcp-tool"
              : (isLocalCommitCmd ? "deterministic-local-worktree-commit" : "deterministic-readonly-bash"),
            precedentId: precId,
            confidence: isLocalCommitCmd ? 0.97 : 0.99,
            action: "answer",
            answer: allowOpt,
            summary: `Auto-allowed ${isStagingMcpTool ? `staging MCP tool (${permName || clampText(question.title, 60)})` : (isLocalCommitCmd ? `local worktree commit (${clampText(cmdCandidate, 90)})` : `read-only inspection (${clampText(cmdCandidate || permName, 90)})`)}`
          };
        }
      }
    }

    const hay = [
      question?.title,
      question?.body,
      thread?.title,
      thread?.lastAgentFull || thread?.lastAgentText,
      pr?.ref,
      ...(pr?.ci?.failing ?? [])
    ]
      .filter(Boolean)
      .join("\n");

    // 2. Deterministic High-Confidence Rule: AppFolio Lifecycles report -> buildbetter-staging MCP.
    if (
      !question
      && /\bappfolio\b/i.test(hay)
      && /\b(?:mcp|workspace|create_report|no result|lifecycles)\b/i.test(hay)
      && !/\bbuildbetter-staging\b[^.\n]{0,60}\bverified\b/i.test(String(thread?.lastAgentText ?? ""))
    ) {
      const prec = this.state.precedents.find((p) => p.id === "prec_appfolio_staging_mcp");
      if (prec && (prec.vetoCount ?? 0) === 0) {
        return {
          matched: true,
          source: "deterministic-staging-mcp",
          precedentId: prec.id,
          confidence: 0.98,
          action: "nudge",
          directive: prec.directive,
          summary: "Routed AppFolio report to buildbetter-staging MCP"
        };
      }
    }

    // 3. Deterministic High-Confidence Rule: TestFlight MISSING_EXPORT_COMPLIANCE
    // (skipped when the session's active goal or owner directive explicitly targets public App Store Review submission).
    const goalContext = [activeGoal?.goal, activeGoal?.doneCriteria, thread?.lastUserText].filter(Boolean).join(" ");
    const targetsAppReviewSubmission = /\b(?:submit\b[^.\n]{0,60}\breview|app\s+(?:store\s+)?review|waiting\s+for\s+review|prepare\s+for\s+submission)\b/i.test(goalContext);
    if (
      !question
      && !targetsAppReviewSubmission
      && /\bMISSING_EXPORT_COMPLIANCE\b/.test(hay)
      && thread?.agentStatus === "idle"
    ) {
      const prec = this.state.precedents.find((p) => p.id === "prec_testflight_export_compliance");
      if (prec && (prec.vetoCount ?? 0) === 0) {
        return {
          matched: true,
          source: "deterministic-export-compliance",
          precedentId: prec.id,
          confidence: 0.94,
          action: "nudge",
          directive: prec.directive,
          summary: "Instructed agent to clear TestFlight export compliance"
        };
      }
    }

    // 4. Deterministic High-Confidence Rule: Transient stream disconnect.
    if (
      !question
      && /\bstream disconnected before completion\b/i.test(String(thread?.error?.text ?? thread?.lastAgentText ?? ""))
      && ["error", "idle", "stalled", "aborted"].includes(String(thread?.agentStatus ?? ""))
    ) {
      const prec = this.state.precedents.find((p) => p.id === "prec_stream_disconnect_retry");
      if (prec && (prec.vetoCount ?? 0) === 0) {
        return {
          matched: true,
          source: "deterministic-stream-disconnect",
          precedentId: prec.id,
          confidence: 0.95,
          action: "nudge",
          directive: prec.directive,
          summary: "Auto-resumed session after transient stream disconnect"
        };
      }
    }

    // 5. Semantic Precedent Retrieval + OpenAI `/v1/decisions` Confidence Gate (>= 0.85).
    if (!question || !["agent-ask", "agent-card", "prompt"].includes(question.kind)) {
      return { matched: false, hardRedLine: null };
    }

    // An explicit Decisions opt-out (`decisions.enabled: false`, which
    // OPENAGI_FLEET_DECISIONS=0 resolves to) blocks every endpoint call below.
    const apiKey = decisionsConfig.enabled === false
      ? ""
      : String(decisionsConfig.apiKey ?? env?.OPENAI_API_KEY ?? "").trim();
    const url = decisionsConfig.url ?? env?.OPENAGI_DECISIONS_URL ?? DEFAULT_DECISIONS_URL;
    const model = decisionsConfig.model ?? env?.OPENAGI_DECISIONS_MODEL ?? DEFAULT_DECISIONS_MODEL;
    const queryText = [question.title, question.body, question.askContext].filter(Boolean).join(" ");
    const repoSlug = pr?.repo ?? thread?.repo ?? question.contextSnapshot?.repo ?? null;
    const ranked = this.state.precedents
      .filter((p) => (p.vetoCount ?? 0) === 0 && p.action === "answer" && p.answer)
      .map((p) => {
        const repoBoost = p.repo === "*" || (repoSlug && p.repo.toLowerCase() === repoSlug.toLowerCase()) ? 0.1 : 0;
        const score = lexicalSimilarity(queryText, `${p.patternSummary} ${p.ownerRule}`) + repoBoost;
        return { precedent: p, score };
      })
      .filter((row) => row.score >= 0.22)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);

    if (ranked.length && apiKey) {
      const top = ranked[0].precedent;
      const matchingOption = (question.options ?? []).find(
        (opt) => String(opt).trim().toLowerCase() === String(top.answer).trim().toLowerCase()
      );
      if (matchingOption) {
        const cacheKey = shortHash(JSON.stringify([question.dedupeKey ?? question.id, top.id, top.updatedAt, matchingOption]));
        const cached = this.decisionCache.get(cacheKey);
        if (cached && this.now() - cached.at < 30 * 60_000) {
          if (cached.result?.matched) return cached.result;
        } else {
          const res = await callDecisionsEndpoint({
            input: {
              current_question: {
                title: clampText(redactSecrets(question.title ?? ""), 160),
                body: clampText(redactSecrets(question.body ?? ""), 400),
                options: (question.options ?? []).slice(0, 4),
                repo: repoSlug
              },
              candidate_precedents: ranked.map(({ precedent }) => ({
                id: precedent.id,
                pattern: precedent.patternSummary,
                owner_rule: precedent.ownerRule,
                historical_answer: precedent.answer,
                approvals: precedent.approvalCount
              })),
              proposed_answer: matchingOption
            },
            questions: [
              {
                type: "predicate",
                name: "matches_precedent",
                instructions:
                  "Did the owner already establish a clear historical precedent in `candidate_precedents` for this exact kind of routine " +
                  "in-scope question such that answering `proposed_answer` faithfully repeats the owner's prior decision without ambiguity?"
              },
              {
                type: "predicate",
                name: "crosses_red_line",
                instructions:
                  "Would answering `proposed_answer` merge a PR, deploy to production, message a customer externally, spend money, " +
                  "delete shared data, or choose a novel product direction that has not been decided before?"
              }
            ],
            apiKey,
            url,
            model,
            timeoutMs: Number(decisionsConfig.timeoutMs) || DEFAULT_DECISIONS_TIMEOUT_MS,
            fetchImpl
          });

          if (res.ok) {
            const pMatch = res.probabilities.get("matches_precedent") ?? 0;
            const pRedLine = res.probabilities.get("crosses_red_line") ?? 1;
            const matched = pMatch >= threshold && pRedLine < 0.15;
            const outcome = matched
              ? {
                  matched: true,
                  source: "decisions-precedent",
                  precedentId: top.id,
                  confidence: pMatch,
                  action: "answer",
                  answer: matchingOption,
                  summary: `Matched owner precedent (${Math.round(pMatch * 100)}% confidence): ${clampText(question.title, 80)} -> ${matchingOption}`
                }
              : { matched: false, hardRedLine: null, confidence: pMatch, pRedLine };
            this.decisionCache.set(cacheKey, { at: this.now(), result: outcome });
            if (outcome.matched) return outcome;
          }
        }
      }
    }

    // 6. Routine Engineering-Hygiene Unblock via `/v1/decisions` (>= 0.88 confidence, < 0.12 owner-judgment risk)
    // for reversible local operational questions (e.g. rerun flaky CI once, close local test browser,
    // use /Volumes/Xtra scratch disk) when exact lexical strings are not yet in precedents.json.
    const hygienePrec = this.state.precedents.find((p) => p.id === "prec_engineering_hygiene");
    if (
      apiKey
      && ["agent-ask", "agent-card"].includes(question.kind)
      && (!hygienePrec || (hygienePrec.vetoCount ?? 0) === 0)
      && !/\b(?:sudo|password|2fa|sso|oauth|api\s*key|secret|apple\s+id|app\s+store|pricing|customer|production|prod\b|merge\b)\b/i.test(queryText)
    ) {
      const concreteOptions = (question.options ?? [])
        .filter((opt) => !/^(?:dismiss|later|skip|wait|stop|open thread|got it|no|cancel)$/i.test(String(opt).trim()))
        .filter((opt) => !HARD_RED_LINE_RULES.some((r) => r.pattern.test(String(opt))))
        .slice(0, 3);
      if (concreteOptions.length > 0) {
        const hygieneCacheKey = shortHash(JSON.stringify(["hygiene", question.dedupeKey ?? question.id, concreteOptions]));
        const cachedHygiene = this.decisionCache.get(hygieneCacheKey);
        if (cachedHygiene && this.now() - cachedHygiene.at < 30 * 60_000) {
          return cachedHygiene.result;
        }
        const hygieneRes = await callDecisionsEndpoint({
          input: {
            owner_policy: hygienePrec?.ownerRule ?? "",
            current_question: {
              title: clampText(redactSecrets(question.title ?? ""), 160),
              body: clampText(redactSecrets(question.body ?? ""), 450),
              ask_context: clampText(redactSecrets(question.askContext ?? ""), 350),
              candidate_options: concreteOptions,
              repo: repoSlug
            }
          },
          questions: [
            ...concreteOptions.map((opt, idx) => ({
              type: "predicate",
              name: `opt_${idx}_routine_hygiene`,
              instructions:
                `Is choosing option ${JSON.stringify(opt)} an unambiguous, reversible, local engineering-hygiene unblock ` +
                `(such as rerunning a flaky CI job once, closing a leftover local test browser/process, using an available ` +
                `external scratch volume like /Volumes/Xtra for builds, or continuing in-scope verification) that Spencer ` +
                `explicitly wants automated without interrupting him?`
            })),
            {
              type: "predicate",
              name: "requires_owner_judgment",
              instructions:
                "Does this question involve any Hard Red Line (PR merge, production deploy/release, external customer outreach, " +
                "paid spend, destructive delete, human login/sudo/credentials) OR a genuine product, UX, scope, or architectural " +
                "trade-off where the owner's preference is uncertain?"
            }
          ],
          apiKey,
          url,
          model,
          timeoutMs: Number(decisionsConfig.timeoutMs) || DEFAULT_DECISIONS_TIMEOUT_MS,
          fetchImpl
        });
        if (hygieneRes.ok) {
          const pNeedsOwner = hygieneRes.probabilities.get("requires_owner_judgment") ?? 1;
          const scored = concreteOptions
            .map((opt, idx) => ({ opt, p: hygieneRes.probabilities.get(`opt_${idx}_routine_hygiene`) ?? 0 }))
            .sort((a, b) => b.p - a.p);
          const best = scored[0];
          const second = scored[1] ?? { p: 0 };
          const hygieneThreshold = Math.max(0.88, threshold);
          const unambiguous = best && best.p >= hygieneThreshold && pNeedsOwner < 0.12 && (scored.length === 1 || best.p - second.p >= 0.25);
          const hygieneOutcome = unambiguous
            ? {
                matched: true,
                source: "decisions-engineering-hygiene",
                precedentId: "prec_engineering_hygiene",
                confidence: best.p,
                action: "answer",
                answer: best.opt,
                summary: `Auto-resolved routine engineering unblock (${Math.round(best.p * 100)}% confidence): ${clampText(question.title, 80)} -> ${best.opt}`
              }
            : { matched: false, hardRedLine: null, confidence: best?.p ?? 0, pRedLine: pNeedsOwner };
          this.decisionCache.set(hygieneCacheKey, { at: this.now(), result: hygieneOutcome });
          return hygieneOutcome;
        }
      }
    }

    return { matched: false, hardRedLine: null };
  }
}

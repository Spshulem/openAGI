// Safe PR merge preflight + execution and natural-utterance card matching.
// Enforces the progressive non-auto-merge contract:
//   1. Default mergePolicy is "manual_confirm" (never passes `gh pr merge --auto`
//      unless the owner explicitly switched mergePolicy to "queue_when_green").
//   2. Verifies PR state, draft flag, expected head SHA, merge conflicts, and
//      CI rollup live right before merging.
//   3. Halts immediately on drift, conflict, or red CI so nothing broken merges.

import { clampText, parsePrRef, redactSecrets, runCommand } from "./contracts.js";
import { requiredChecksFor } from "./sources/github.js";
import { githubThrottle, throttledGh } from "./github-throttle.js";

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// GitHub works out mergeability lazily: right after anything lands on a PR's
// base (another merge), mergeable / mergeStateStatus read UNKNOWN for a few
// seconds. The preflight reads it again this many times, waiting between
// reads, before calling the outcome unknown. Reads only; nothing is merged
// on a state the preflight has not seen.
const MERGEABILITY_REREAD_DELAYS_MS = [2_000, 4_000];
const PR_VIEW_FIELDS = "state,isDraft,mergeStateStatus,mergeable,reviewDecision,headRefOid,statusCheckRollup,url";
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const FAILED_STATES = new Set(["FAILURE", "ERROR"]);
const PENDING_STATUSES = new Set(["IN_PROGRESS", "QUEUED", "WAITING", "PENDING", "REQUESTED"]);
const PENDING_STATES = new Set(["PENDING", "EXPECTED"]);
const GREEN_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const GREEN_STATES = new Set(["SUCCESS"]);

function rollupPassesConfiguredGates(rollup, repo, config) {
  const required = requiredChecksFor(repo, config);
  if (!required.length) return true;
  const list = Array.isArray(rollup) ? rollup : [];
  return required.every(({ name }) => {
    const matches = list.filter((item) => item && (item.name === name || item.context === name));
    if (!matches.length) return false;
    return matches.some((item) => {
      const state = String(item.state ?? "").toUpperCase();
      const status = String(item.status ?? "").toUpperCase();
      const conclusion = String(item.conclusion ?? "").toUpperCase();
      if (state) return GREEN_STATES.has(state);
      return status === "COMPLETED" && GREEN_CONCLUSIONS.has(conclusion);
    });
  });
}

async function verifyRequiredBranchChecks(run, ghBin, parsed) {
  const res = await run(
    ghBin,
    ["pr", "checks", String(parsed.number), "--repo", parsed.repo, "--required", "--json", "name,state,bucket"],
    { timeoutMs: 15_000 }
  );
  if (res.throttled) return { ok: false, throttled: true, detail: String(res.stderr ?? "") };
  if (res.code !== 0) {
    const combined = `${res.stderr ?? ""}\n${res.stdout ?? ""}`;
    if (/no required checks/i.test(combined)) return { ok: true };
    return {
      ok: false,
      detail: clampText(redactSecrets(res.stderr || res.stdout || "Required branch checks have not all completed and passed."), 220)
    };
  }
  let checks;
  try {
    checks = JSON.parse(res.stdout || "[]");
  } catch {
    return { ok: false, detail: "Could not parse required branch checks before admin merge override." };
  }
  if (!Array.isArray(checks)) return { ok: false, detail: "Unexpected required checks payload from GitHub." };
  const incomplete = checks.filter((c) => !["pass", "skipping"].includes(String(c?.bucket ?? "").toLowerCase()));
  if (incomplete.length > 0) {
    const names = incomplete.map((c) => c?.name || "required check").slice(0, 3).join(", ");
    return { ok: false, detail: `Required check(s) not yet passing (${names}). Merge halted safely.` };
  }
  return { ok: true };
}

function summarizeRollup(rollup) {
  const list = Array.isArray(rollup) ? rollup : [];
  const failing = [];
  const pending = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const name = item.name || item.context || "check";
    const status = String(item.status ?? "").toUpperCase();
    const conclusion = String(item.conclusion ?? "").toUpperCase();
    const state = String(item.state ?? "").toUpperCase();
    if (FAILED_CONCLUSIONS.has(conclusion) || FAILED_STATES.has(state)) {
      failing.push(name);
    } else if ((status && status !== "COMPLETED" && PENDING_STATUSES.has(status)) || PENDING_STATES.has(state)) {
      pending.push(name);
    }
  }
  return { failing: [...new Set(failing)], pending: [...new Set(pending)] };
}

export async function executeSafePrMerge({
  prRef,
  expectedHeadSha = null,
  mergePolicy = "manual_confirm",
  ownerConfirmed = false,
  config = null,
  ghBin = "gh",
  run: rawRun = runCommand,
  throttle = githubThrottle,
  sleep = defaultSleep,
  rereadDelaysMs = MERGEABILITY_REREAD_DELAYS_MS
} = {}) {
  const parsed = parsePrRef(prRef);
  if (!parsed || !REPO_PATTERN.test(parsed.repo) || !(parsed.number > 0)) {
    return { status: "halted", reason: "invalid_pr_ref", detail: "Invalid pull request reference." };
  }
  // Every GitHub call here shares the account's GraphQL cooldown, is never
  // merged with another caller's (each preflight is its own fresh read), and
  // is never repeated after a throttle: the owner taps Merge again, which
  // re-runs this whole preflight first.
  const run = (bin, args, options) => throttledGh(rawRun, bin, args, options, { throttle, background: false, coalesce: false });
  const held = throttle.blocking({ background: false });
  if (held) return rateLimitedHalt(prRef, held, { step: "before" });

  // One live read of the PR: { view } or { halt }.
  const readPr = async () => {
    const viewRes = await run(ghBin, ["pr", "view", String(parsed.number), "--repo", parsed.repo, "--json", PR_VIEW_FIELDS], { timeoutMs: 25_000 });
    if (viewRes.throttled) return { halt: rateLimitedHalt(prRef, viewRes.cooldown ?? throttle.blocking({ background: false }), { step: "preflight" }) };
    if (viewRes.code !== 0 || !viewRes.stdout) {
      return { halt: {
        status: "halted",
        reason: "github_unreachable",
        haltClass: "unknown",
        mergeConfirmed: false,
        detail: clampText(redactSecrets(viewRes.stderr || viewRes.error || "Could not verify PR status on GitHub before merging."), 220)
      } };
    }
    try {
      return { view: JSON.parse(viewRes.stdout) };
    } catch {
      return { halt: { status: "halted", reason: "github_parse_error", haltClass: "unknown", mergeConfirmed: false, detail: "Could not parse GitHub PR status." } };
    }
  };
  const pendingMergeability = (v) => String(v?.state ?? "").toUpperCase() === "OPEN"
    && (String(v?.mergeable ?? "").toUpperCase() === "UNKNOWN" || String(v?.mergeStateStatus ?? "").toUpperCase() === "UNKNOWN");

  let read = await readPr();
  if (read.halt) return read.halt;
  let view = read.view;
  let reads = 1;
  for (const delay of rereadDelaysMs) {
    if (!pendingMergeability(view)) break;
    await sleep(delay);
    read = await readPr();
    if (read.halt) return read.halt;
    view = read.view;
    reads += 1;
  }

  const state = String(view.state ?? "").toUpperCase();
  if (state === "MERGED") {
    return { status: "already_merged", prRef, url: view.url ?? null, detail: `${prRef} is already merged.` };
  }
  if (state !== "OPEN") {
    return { status: "halted", reason: "pr_closed", prRef, detail: `${prRef} is ${state.toLowerCase() || "closed"}; nothing was merged.` };
  }
  if (view.isDraft === true) {
    return { status: "halted", reason: "draft_pr", prRef, detail: `${prRef} is still a draft PR.` };
  }

  const liveSha = String(view.headRefOid ?? "").trim();
  const pinnedSha = String(expectedHeadSha ?? "").trim();
  if (pinnedSha && liveSha && !liveSha.startsWith(pinnedSha) && !pinnedSha.startsWith(liveSha)) {
    return {
      status: "halted",
      reason: "head_changed",
      prRef,
      headRefOid: liveSha,
      detail: `New commit (${liveSha.slice(0, 7)}) landed on ${prRef} after review. Inspect the updated diff before merging.`
    };
  }

  const mergeState = String(view.mergeStateStatus ?? "").toUpperCase();
  const mergeable = String(view.mergeable ?? "").toUpperCase();
  if (mergeState === "DIRTY" || mergeable === "CONFLICTING") {
    return {
      status: "halted",
      reason: "merge_conflict",
      prRef,
      canFixCi: true,
      detail: `${prRef} has merge conflicts with base. Send back to the coding session to rebase.`
    };
  }

  const { failing, pending } = summarizeRollup(view.statusCheckRollup);
  if (failing.length > 0) {
    return {
      status: "halted",
      reason: "ci_failed",
      prRef,
      canFixCi: true,
      failingChecks: failing.slice(0, 5),
      detail: `CI failed on ${prRef} (${failing.slice(0, 3).join(", ")}). Merge halted safely.`
    };
  }

  const headArgs = liveSha ? ["--match-head-commit", liveSha] : [];

  if (pending.length > 0) {
    if (mergePolicy === "queue_when_green") {
      const queueRes = await run(
        ghBin,
        ["pr", "merge", String(parsed.number), "--repo", parsed.repo, "--auto", "--squash", ...headArgs],
        { timeoutMs: 30_000 }
      );
      if (queueRes.throttled) return rateLimitedHalt(prRef, queueRes.cooldown ?? throttle.blocking({ background: false }), { step: "merge" });
      if (queueRes.code === 0) {
        return {
          status: "queued_when_green",
          prRef,
          headRefOid: liveSha || null,
          url: view.url ?? null,
          detail: `Queued squash merge for ${prRef} once ${pending.length} running check(s) pass.`
        };
      }
      return {
        status: "halted",
        reason: "gh_queue_failed",
        prRef,
        detail: clampText(redactSecrets(queueRes.stderr || queueRes.stdout || "GitHub refused auto-merge queue on this repo."), 220)
      };
    }
    return {
      status: "watching_ci",
      prRef,
      promptPreference: true,
      pendingChecks: pending.slice(0, 5),
      detail: `CI is still running on ${prRef} (${pending.slice(0, 2).join(", ")}). Auto-merge is off by default—watching CI and will ping you when green.`
    };
  }

  if (mergeState === "BEHIND") {
    return {
      status: "halted",
      reason: "behind_base",
      prRef,
      canFixCi: true,
      detail: `${prRef} is behind the base branch and must be updated before merging.`
    };
  }

  const reviewDecision = String(view.reviewDecision ?? "").toUpperCase();
  const hasNonEmptyGreenRollup = Array.isArray(view.statusCheckRollup) && view.statusCheckRollup.length > 0;
  const configuredGatesGreen = rollupPassesConfiguredGates(view.statusCheckRollup, parsed.repo, config);
  const ownerOverrideEligible = ownerConfirmed === true
    && mergeState === "BLOCKED"
    && mergeable === "MERGEABLE"
    && reviewDecision === "REVIEW_REQUIRED"
    && hasNonEmptyGreenRollup
    && configuredGatesGreen;

  // Three different stops, said differently: GitHub has not decided yet
  // (transient), GitHub's rules confirm a block (policy), or checks GitHub
  // counts are not all passing. Each fails closed: nothing is merged.
  if (mergeable === "UNKNOWN" || mergeState === "UNKNOWN") {
    return {
      status: "halted",
      reason: "mergeability_unknown",
      haltClass: "transient",
      mergeConfirmed: false,
      prRef,
      detail: `Not merged: ${prRef}. GitHub had not finished working out whether it can merge (still UNKNOWN after ${reads} live reads); this usually happens for a few seconds after another merge into its base branch. No branch rule or check failure was reported, and nothing was sent to merge. Tap Merge again; it re-checks live state first.`
    };
  }
  if (mergeState === "BLOCKED" && !ownerOverrideEligible) {
    return {
      status: "halted",
      reason: "blocked",
      haltClass: "policy",
      mergeConfirmed: false,
      prRef,
      detail: `Not merged: GitHub reports ${prRef} as BLOCKED by its branch rules (review decision: ${reviewDecision || "none reported"}; mergeable: ${mergeable || "not reported"}). Merging needs what those rules require, such as an approving review or required checks.`
    };
  }
  if (mergeState === "UNSTABLE") {
    return {
      status: "halted",
      reason: "checks_unstable",
      haltClass: "policy",
      mergeConfirmed: false,
      prRef,
      detail: `Not merged: GitHub reports ${prRef} as UNSTABLE (some commit status it tracks is not passing). Merge halted safely.`
    };
  }

  const mergeRes = await run(
    ghBin,
    ["pr", "merge", String(parsed.number), "--repo", parsed.repo, "--squash", ...headArgs],
    { timeoutMs: 30_000 }
  );
  // Refused for the limit: GitHub ran no merge. Stop here (no admin retry).
  if (mergeRes.throttled) return rateLimitedHalt(prRef, mergeRes.cooldown ?? throttle.blocking({ background: false }), { step: "merge" });
  if (mergeRes.code === 0) {
    return {
      status: "merged",
      prRef,
      headRefOid: liveSha || null,
      url: view.url ?? null,
      detail: `Merged ${prRef} via squash.`
    };
  }
  // gh reported a failure: GitHub's own state says whether it merged anyway
  // (a lost reply) before anything else is tried.
  const after = await readPr();
  // That read itself failed (unreachable, unparseable, or throttled): the
  // merge may or may not have happened, so this is never a confirmed refusal,
  // and nothing more (no admin retry) is tried on top of an unknown outcome.
  if (after.halt) {
    return {
      status: "halted",
      reason: "merge_unconfirmed",
      haltClass: "unknown",
      mergeConfirmed: false,
      prRef,
      detail: clampText(`gh reported the merge as failed, and GitHub could not be read back to confirm it (${redactSecrets(after.halt.detail ?? after.halt.reason ?? "no detail")}). ${prRef} may have merged: check it on GitHub before trying again.`, 320)
    };
  }
  if (after.view && String(after.view.state ?? "").toUpperCase() === "MERGED") {
    const mergedHead = String(after.view.headRefOid ?? "").trim();
    if (!liveSha || !mergedHead || mergedHead === liveSha) {
      return {
        status: "merged",
        prRef,
        headRefOid: mergedHead || liveSha || null,
        url: after.view.url ?? view.url ?? null,
        reconciled: true,
        detail: `Merged ${prRef} (GitHub shows it merged at the reviewed head although gh reported an error).`
      };
    }
    return {
      status: "halted",
      reason: "head_changed",
      haltClass: "unknown",
      mergeConfirmed: false,
      prRef,
      headRefOid: mergedHead,
      detail: `${prRef} shows as merged on GitHub, but at ${mergedHead.slice(0, 7)}, not the reviewed head ${liveSha.slice(0, 7)}. Check it on GitHub.`
    };
  }

  if (ownerOverrideEligible || (ownerConfirmed === true && mergeable === "MERGEABLE" && hasNonEmptyGreenRollup && configuredGatesGreen && reviewDecision === "REVIEW_REQUIRED")) {
    const reqVerification = await verifyRequiredBranchChecks(run, ghBin, parsed);
    if (reqVerification.throttled) return rateLimitedHalt(prRef, throttle.blocking({ background: false }), { step: "preflight" });
    if (!reqVerification.ok) {
      return {
        status: "halted",
        reason: "blocked",
        prRef,
        detail: reqVerification.detail
      };
    }
    const adminRes = await run(
      ghBin,
      ["pr", "merge", String(parsed.number), "--repo", parsed.repo, "--admin", "--squash", ...headArgs],
      { timeoutMs: 30_000 }
    );
    if (adminRes.throttled) return rateLimitedHalt(prRef, adminRes.cooldown ?? throttle.blocking({ background: false }), { step: "merge" });
    if (adminRes.code === 0) {
      return {
        status: "merged",
        prRef,
        headRefOid: liveSha || null,
        url: view.url ?? null,
        adminOverride: true,
        detail: `Merged ${prRef} via squash (owner-confirmed branch protection override).`
      };
    }
    return {
      status: "halted",
      reason: "gh_merge_failed",
      haltClass: "refused",
      mergeConfirmed: false,
      prRef,
      detail: clampText(redactSecrets(adminRes.stderr || adminRes.stdout || mergeRes.stderr || mergeRes.stdout || "GitHub refused the merge (check branch protection or admin permissions)."), 220)
    };
  }

  return {
    status: "halted",
    reason: "gh_merge_failed",
    haltClass: "refused",
    mergeConfirmed: false,
    prRef,
    detail: clampText(redactSecrets(mergeRes.stderr || mergeRes.stdout || "GitHub refused the merge (check branch protection reviews)."), 220)
  };
}

// A merge stopped by GitHub's rate limit. Says plainly that nothing merged,
// whether anything reached GitHub, and when trying again can work. The card
// stays open; nothing is replayed automatically.
function rateLimitedHalt(prRef, cooldown, { step }) {
  const until = cooldown?.until ?? null;
  const when = until ? `${new Date(until).toISOString().slice(11, 16)} UTC` : "GitHub's limit resets";
  const why = cooldown?.kind === "secondary" ? "GitHub asked this account to slow down (secondary rate limit)" : "GitHub's GraphQL rate limit for this account is used up";
  const what = step === "before"
    ? "Nothing was sent to GitHub."
    : step === "preflight"
      ? "GitHub refused the pre-merge check, so no merge was sent."
      : "GitHub refused the merge request itself; no merge is confirmed.";
  return {
    status: "halted",
    reason: "github_rate_limited",
    prRef,
    mergeConfirmed: false,
    retryAt: until,
    throttleKind: cooldown?.kind ?? "primary",
    detail: `Not merged: ${prRef}. ${why} until ${when}. ${what} Nothing retries on its own; tap Merge after ${when} and it re-checks the PR (head commit, checks, reviews) before merging.`
  };
}

// Resolves which SupervisorCard a natural-language reply targets:
//   - Semantic override if the utterance names a PR number (#281) or repo/workspace
//   - Else the focused card above the composer
//   - Else the top card in the deck
export function matchCardForUtterance(cards = [], text = "", focusedCardId = null) {
  if (!Array.isArray(cards) || cards.length === 0) return null;
  const lower = String(text ?? "").toLowerCase();

  const prMatch = /(?:#|pr\s+)(\d+)\b/i.exec(lower);
  if (prMatch) {
    const num = Number(prMatch[1]);
    const byPr = cards.find((c) => c.prNumber === num || String(c.prRef ?? "").endsWith(`#${num}`));
    if (byPr) return byPr;
  }

  const words = lower.split(/[^a-z0-9_-]+/).filter((w) => w.length >= 3);
  if (words.length > 0) {
    let best = null;
    let bestHits = 0;
    for (const card of cards) {
      const targetText = [card.repo, card.workspace, card.branch, card.headline]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const hits = words.filter((w) => !["the", "one", "that", "this", "for", "and", "yes", "yeah", "merge", "ship", "approve"].includes(w) && targetText.includes(w)).length;
      if (hits > bestHits) {
        bestHits = hits;
        best = card;
      }
    }
    if (best && bestHits >= 1) return best;
  }

  if (focusedCardId) {
    const focused = cards.find((c) => c.id === focusedCardId || c.questionId === focusedCardId);
    if (focused) return focused;
  }
  return cards[0];
}

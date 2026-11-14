// Safe PR merge preflight + execution and natural-utterance card matching.
// Enforces the progressive non-auto-merge contract:
//   1. Default mergePolicy is "manual_confirm" (never passes `gh pr merge --auto`
//      unless the owner explicitly switched mergePolicy to "queue_when_green").
//   2. Verifies PR state, draft flag, expected head SHA, merge conflicts, and
//      CI rollup live right before merging.
//   3. Halts immediately on drift, conflict, or red CI so nothing broken merges.

import { clampText, parsePrRef, redactSecrets, runCommand } from "./contracts.js";

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const FAILED_STATES = new Set(["FAILURE", "ERROR"]);
const PENDING_STATUSES = new Set(["IN_PROGRESS", "QUEUED", "WAITING", "PENDING", "REQUESTED"]);
const PENDING_STATES = new Set(["PENDING", "EXPECTED"]);

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
  ghBin = "gh",
  run = runCommand
} = {}) {
  const parsed = parsePrRef(prRef);
  if (!parsed || !REPO_PATTERN.test(parsed.repo) || !(parsed.number > 0)) {
    return { status: "halted", reason: "invalid_pr_ref", detail: "Invalid pull request reference." };
  }

  const viewRes = await run(
    ghBin,
    [
      "pr", "view", String(parsed.number),
      "--repo", parsed.repo,
      "--json", "state,isDraft,mergeStateStatus,mergeable,headRefOid,statusCheckRollup,url"
    ],
    { timeoutMs: 25_000 }
  );

  if (viewRes.code !== 0 || !viewRes.stdout) {
    return {
      status: "halted",
      reason: "github_unreachable",
      detail: clampText(redactSecrets(viewRes.stderr || viewRes.error || "Could not verify PR status on GitHub before merging."), 220)
    };
  }

  let view;
  try {
    view = JSON.parse(viewRes.stdout);
  } catch {
    return { status: "halted", reason: "github_parse_error", detail: "Could not parse GitHub PR status." };
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

  if (mergeState === "BLOCKED" || mergeState === "UNSTABLE" || mergeable === "UNKNOWN") {
    return {
      status: "halted",
      reason: "blocked",
      prRef,
      detail: `${prRef} is blocked by branch protection, unposted checks, or required reviews (${mergeState || mergeable}). Merge halted safely.`
    };
  }

  const mergeRes = await run(
    ghBin,
    ["pr", "merge", String(parsed.number), "--repo", parsed.repo, "--squash", ...headArgs],
    { timeoutMs: 30_000 }
  );
  if (mergeRes.code === 0) {
    return {
      status: "merged",
      prRef,
      headRefOid: liveSha || null,
      url: view.url ?? null,
      detail: `Merged ${prRef} via squash.`
    };
  }
  return {
    status: "halted",
    reason: "gh_merge_failed",
    prRef,
    detail: clampText(redactSecrets(mergeRes.stderr || mergeRes.stdout || "GitHub refused the merge (check branch protection reviews)."), 220)
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

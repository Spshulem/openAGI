// A diagnosis is a private problem record, not permission to run a coder.
export const REMEDIES = Object.freeze(["skill", "clarification", "setup", "code", "feature"]);
export const REMEDY_LABELS = Object.freeze({ skill: "Improve a skill", clarification: "Ask a question", setup: "Setup needed", code: "Code repair", feature: "Capability proposal" });

// Missing remedy supports already-persisted, pre-routing records.
export function remedyOf(suggestion) { return suggestion.remedy ?? "code"; }

export function assertCodeRemedy(suggestion) {
  if (remedyOf(suggestion) !== "code") throw new Error("This problem needs a local plan, not a coding run.");
}

export function suggestionPlan(suggestion) {
  const remedy = remedyOf(suggestion);
  if (!REMEDIES.includes(remedy)) throw new Error("Unknown remedy.");
  return {
    remedy, label: REMEDY_LABELS[remedy], nextAction: suggestion.nextAction ?? suggestion.proposedFix,
    acceptance: suggestion.acceptance,
    // Public drafts exclude private diagnosis, action IDs and logs. The owner
    // supplies a sanitized reproduction before submitting an issue.
    issueDraft: remedy === "code" || remedy === "feature" ? {
      title: remedy === "code" ? "OpenAGI behavior needs a reproducible repair" : "OpenAGI capability proposal",
      body: "Describe the expected behavior and a minimal synthetic reproduction here.\n\nExclude personal content, installation details, credentials and private logs.\n\nThis is a local draft; no issue has been submitted."
    } : null
  };
}

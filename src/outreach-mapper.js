// src/outreach-mapper.js
// The ONLY bridge between existing detection and the outreach feed. It listens
// to events the runtime already emits and turns each into one outreach item.
// Nothing in the observer / miners / planner / stores changes.

const MAP = {
  "draft-created": (d) => ({
    type: "draft",
    sourceRef: { kind: "draft", id: d.id },
    title: d.title ?? "Draft ready",
    summary: (d.body ?? "").slice(0, 160),
    needsDecision: false,
    actions: ["approve", "edit", "dismiss"]
  }),
  "proactive-suggestion": (d) => ({
    type: "suggestion",
    sourceRef: { kind: "suggestion", id: d.id },
    title: d.title ?? "New suggestion",
    summary: d.rationale ?? "",
    needsDecision: false,
    actions: ["accept", "dismiss"]
  }),
  "pending-action": (d) => ({
    type: "pending-action",
    sourceRef: { kind: "pending-action", id: d.id },
    title: d.summary ?? "Action needs approval",
    summary: d.reason ?? "",
    needsDecision: true,
    actions: ["do", "dismiss"]
  }),
  "clarification-created": (d) => ({
    type: "clarification",
    sourceRef: { kind: "clarification", id: d.id },
    title: d.question ?? "Quick question",
    summary: d.context ?? "",
    needsDecision: true,
    actions: ["yes", "no", "in_progress", "dropped"]
  })
};

export class OutreachMapper {
  constructor({ store, events }) {
    this.store = store;
    this.events = events;
    this._handlers = [];
  }

  attach() {
    if (this._handlers.length) this.detach();
    for (const [event, build] of Object.entries(MAP)) {
      const handler = (data) => {
        try {
          const spec = build(data ?? {});
          if (spec) this.store.append(spec);
        } catch { /* never let a malformed event break the bus */ }
      };
      this.events.on(event, handler);
      this._handlers.push([event, handler]);
    }
  }

  detach() {
    for (const [event, handler] of this._handlers) this.events.off(event, handler);
    this._handlers = [];
  }
}

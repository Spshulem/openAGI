import { isSavedMemory } from "./memory-system.js";

// Read existing evidence; opening a guide never marks a capability complete.
// Do not return conversation text, keys, project paths or memory contents.
export function getStartedStatus(runtime) {
  const host = runtime.agentHost;
  const configured = Boolean(host?.modelProvider?.isConfigured?.())
    && host.modelProvider.constructor?.name !== "DeterministicModelProvider";
  const sessions = host?.store?.listSessions?.({ limit: 50 }) ?? [];
  const firstReply = sessions.some(session => {
    if (!/^(local|web|http):/.test(session.id) || /:cron:|:autopilot:/.test(session.id)) return false;
    try {
      const messages = host.store.getSession(session.id)?.messages ?? [];
      return messages.some(message => message.role === "assistant" && message.content?.trim()
        && message.metadata?.model && message.metadata.model !== "deterministic"
        && message.metadata?.provider && message.metadata?.provider !== "deterministic");
    } catch { return false; }
  });
  const memories = [...(runtime.memory?.items?.values?.() ?? [])]
    .filter(item => !item.metadata?.supersededBy && (item.scope ?? "main") === "main" && isSavedMemory(item));
  const coding = runtime.codingSupervisor?.builtin?.list?.().sessions ?? [];
  const codingSession = coding.some(session => session.status === "idle" && session.replyAvailable);
  return {
    model: configured, chat: firstReply,
    memory: memories.some(item => item.metadata?.recalledInOtherSession === true),
    memorySaved: memories.length > 0, agents: codingSession
  };
}

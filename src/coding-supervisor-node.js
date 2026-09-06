import { CodingSupervisor, runSupervisorAdapter, validateCodingTarget } from './coding-supervisor.js';

export const CODING_CAPABILITY = 'coding-supervisor';
const OPERATIONS = ['setup', 'configure', 'list', 'inspect', 'prepare-start', 'start', 'reply', 'stop', 'reconcile'];

// Only consumed by an enrolled node's outbound authenticated worker. There is
// no inbound server, owner token, shell command, or model-selected backend path.
export function createCodingNodeCapability({ dataDir, backendDir, stateFile, builtinOptions, externalCall } = {}) {
  let supervisor;
  const external = externalCall ?? (backendDir ? (request, options) => runSupervisorAdapter(request, { backendDir, stateFile, ...options }) : null);
  const call = async (request, options) => {
    const managed = supervisor.builtin.list();
    if (request.operation === 'list') {
      let discovered = { sessions: [] };
      let discoveryIncomplete = false;
      if (external) {
        try {
          discovered = await external(request, options);
          if (!Array.isArray(discovered?.sessions) || discovered.sessions.length > 200) throw new Error('Invalid discovery list.');
          const managedKeys = new Set(managed.sessions.map(row => `${row.provider}:${row.sessionId}`));
          const counts = new Map();
          const valid = [];
          for (const row of discovered.sessions) {
            // Count even malformed duplicates: a valid-looking twin must not
            // turn an ambiguous external target into permission to send.
            const key = `${row?.provider}:${row?.sessionId}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
            try {
              validateCodingTarget(row);
              if (!['working', 'idle', 'waiting', 'stuck', 'failed', 'interrupted'].includes(row.status)
                || !/^[a-f0-9]{64}$/.test(row.fingerprint ?? '')) throw new Error('Invalid discovery entry.');
              valid.push(row);
            } catch { discoveryIncomplete = true; }
          }
          discovered = { sessions: valid.filter(row => {
            const key = `${row.provider}:${row.sessionId}`;
            if (counts.get(key) !== 1 || managedKeys.has(key)) { discoveryIncomplete = true; return false; }
            return true;
          }) };
        } catch {
          // An unavailable or invalid whole response still fails closed.
          discovered = { sessions: [] };
          discoveryIncomplete = true;
        }
      }
      const nativeIds = new Set([...supervisor.builtin.records.values()].map(row => `${row.provider}:${row.nativeId}`));
      const sessions = [...managed.sessions, ...discovered.sessions.filter(row => !nativeIds.has(`${row.provider}:${row.sessionId}`))];
      return { discoveryIncomplete: discoveryIncomplete || sessions.length > 200, sessions: sessions.slice(0, 200) };
    }
    if (managed.sessions.some(row => row.provider === request.provider && row.sessionId === request.sessionId)) return supervisor.builtin.call(request);
    if (!external) throw new Error('The coding session is not managed by this node.');
    return external(request, options);
  };
  supervisor = new CodingSupervisor({ dataDir, remoteNodeId: null, call, builtinOptions });
  return {
    supervisor,
    capability: { id: CODING_CAPABILITY, ready: true, operations: OPERATIONS, detail: 'Approval-gated coding supervisor; active desktop writers remain protected' },
    async execute(command) {
      if (command?.capability !== CODING_CAPABILITY || !OPERATIONS.includes(command.operation)) throw new Error('Unsupported coding operation.');
      const args = command.payload ?? {};
      if (args.operation !== command.operation) throw new Error('Mismatched coding operation.');
      if (command.operation === 'setup') return supervisor.builtin.setup();
      if (command.operation === 'configure') return supervisor.builtin.configure({ enabled: args.enabled, workspaces: args.workspaces });
      if (command.operation === 'stop') return supervisor.builtin.cancel(args);
      if (command.operation === 'reconcile') return supervisor.builtin.reconcile(args);
      if (command.operation === 'list') return supervisor.list();
      if (command.operation === 'inspect') return supervisor.inspect(args);
      if (command.operation === 'prepare-start') return supervisor.builtin.prepare(args);
      if (command.operation === 'start') return supervisor.builtin.start(args);
      if (command.operation === 'reply') return supervisor.reply(args);
      throw new Error('Unsupported coding operation.');
    },
    stop() { supervisor.stop(); }
  };
}

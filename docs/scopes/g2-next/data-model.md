# State and entities

- Request receipt: node binding, client request key, payload hash, immutable conversation binding, created/expiry times, accepted/working/completed/failed/cancelled/unconfirmed state, bounded public stage/partial text, optional terminal result. No provider key, raw audio, tool arguments, or private reasoning.
- Request identity includes an issuance timestamp and random UUID. Its fixed recovery lifetime prevents an expired/pruned request from becoming new work when replayed.
- Navigation: Talk/Inbox/History/Settings plus History Chats/Lifelog filter; independent of microphone and request state.
- Capture: persisted Lifelog preference, explicit user-pause flag, existing consent grant, and actual runtime capture state. Only the original consent validity authorizes resumption.
- Conversation: canonical main-owned session. Scoped history returns only user/public assistant content and an opaque continuation discriminator bound to the requesting G2.
- Interface preference: Simplified or Classic, independent of credentials and recording consent.

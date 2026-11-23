# Cross-device Supervisor chat queue QA

Drives the real Mac (`SharedSupervisorClient`) and iPhone (`ChatConversation`)
client code against one isolated hub, at the same moment, and records what
each device saw next to what the hub received and ran. Synthetic data only:
the hub has its own data directory and never touches `~/.openagi` or the
owner's main.

- `hub.mjs`: an isolated hub with a harmless model ("[slow]" waits, anything
  else is acknowledged) and one paired phone. Writes `calls.jsonl` (execution
  receipts, in order), `records.jsonl` (every stored record of the shared
  Supervisor conversation, with its client `requestId`), `hub.json`.
- `run-e2e.sh <out> <simulator-udid> <lan-ip>` (on a Mac): builds both test
  targets, starts the hub on the Mac's LAN address (the iPhone client refuses
  loopback), and runs `CrossDeviceQueueE2ETests` in the simulator and in the
  Mac package at one shared T0. Each writes its own view (`iphone.jsonl`,
  `mac.jsonl`); the script saves `history.json` and `hub-queue.json`.

Phase 1: the iPhone starts a slow turn; at T0 both devices send two tagged
messages. Phase 2 (hub queue only): the Mac edits one of its queued messages
while the iPhone tries to (refused, held), the iPhone removes another Mac
message, and the Mac sends an iPhone message now, which stops the iPhone's
running turn.

This is the simulator and the Mac test runner on one machine, not two
physical devices: it exercises the real client code and transport, not iOS
backgrounding, push, or a physical network.

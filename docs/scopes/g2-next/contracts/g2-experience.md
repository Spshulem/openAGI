# G2 experience protocol

Add `POST /nodes/g2/experience`, requiring the existing G2-scoped bearer and optional matching node ID. It is not a public route. Authenticated token-only compatible agents use the same exact-route exception as current G2 endpoints.

Operations:

- `capabilities`: protocol version, configured (not paid-tested) speech modes, request recovery support, scoped history, and safe main name/role. No private topology, credentials or owner data.
- `submit`: client request ID and the existing bounded ask payload. Validate and persist receipt before invoking the existing channel. Identical retries return the same receipt; changed payloads conflict. Audio is transient.
- `get`: retrieve this node's request receipt. Never create work.
- `cancel`: explicitly stop this node's request. Completed actions are not undone.
- `history`: bounded public messages/conversations from this node's canonical sessions; validate provenance/namespace, never accept arbitrary owner session IDs.

Recovery is bounded, not a claim of globally exactly-once external effects. Restart-interrupted work becomes unconfirmed and never automatically executes again. Revocation and expiry are enforced on reads and active work. Generic old hosts retain the existing API without new capability assumptions.

Connection transfer: an explicit text card with format/version, exact HTTPS origin and six-digit expiring code. Parse strictly; reject credentials in URLs, unknown fields, oversized data and expired cards. Never execute a transfer automatically, change the main without confirmation, or carry an owner token.

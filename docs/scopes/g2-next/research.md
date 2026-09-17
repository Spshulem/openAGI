# Research decisions

- Keep the pinned Even SDK 0.0.15. The existing bridge already supplies the required capture/display/gesture boundaries; hold/release still requires device verification.
- A camera-to-plugin universal link is not established by available source. Implement paste connection plus manual HTTPS origin/code fallback; do not invent a native deep link or enable camera access.
- Existing G2 sessions use a hashed node/conversation namespace. Preserve exact scoped continuation rather than treating a session ID as a new conversation ID. Existing owner `/sessions` APIs remain owner-only.
- Request IDs passed to AgentHost are correlation, not deduplication. Model the new receipt store on the existing coding-supervisor durable claim/hash/no-replay-after-restart pattern.
- Keep the existing provider budget guard and model selection. Capability reads, history reads and request polling never invoke a model.
- `bb-remote` on this laptop uses force push and hook bypass internally to transfer a checkout. Those operations conflict with the task's git safety rules. Use a committed Git archive transferred to a new owned BuildBot3 temporary directory for production verification instead; never transfer private runtime data.
- Preserve all safety/lifecycle limits. Submission status cannot establish reliable phone-lock recording; leave the experiment off by default.

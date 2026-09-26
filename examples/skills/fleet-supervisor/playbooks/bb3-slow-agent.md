---
id: bb3-slow-agent
cooldown_min: 30
max_attempts: 2
ask: ""
---
Your full BuildBot3 verify has run {age} min. Don't run the full verification, and don't shut down any previews. Run bb-quick, push, and let hosted CI be the gate. Full bb-verify only to reproduce a hosted CI failure.

---
id: ci-finished
cooldown_min: 12
max_attempts: 3
ask: "#{pr} CI done, agent idle. Help?"
---
CI finished on {head}: {ci}. Continue: fix failures, resolve 6/10+ threads, get merge-ready. If CI failed, you might need to just pull main to fix it, but get PR verify going and then resolve all PR comments. If you were waiting on something else, check it now and keep going.

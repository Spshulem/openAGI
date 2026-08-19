# Runbook: declare this Mac the main (unpair from a remote Distiller)

Use this when a Mac that runs the full packaged OpenAGI app (its own daemon,
memory, outcomes, and 700MB+ of observations) is still *paired* to a remote
main via `~/.openagi/node.json`. The pairing only redirects the `openagi` CLI;
capture, memory, and the agent already run locally. Unpairing makes the local
daemon the single brain on purpose instead of by accident.

Everything below is a config flip — no code changes, nothing deleted without a
backup. Run each step yourself; where a value comes from `~/.openagi/.env`,
open that file yourself and do not paste secrets into an agent chat.

## Checklist

1. **Confirm a pairing exists.**
   ```sh
   ls -l ~/.openagi/node.json
   openagi doctor
   ```
   Expected: the file exists, and doctor's first check reads
   `remote main → http://<distiller-host>:43210 (via node.json)`.
   If doctor already says `local daemon → ... (via local)`, stop — nothing to do.

2. **Back up the pairing (reversal insurance).**
   ```sh
   cp ~/.openagi/node.json ~/.openagi/node.json.bak
   ```

3. **Unpair.**
   ```sh
   openagi unpair
   ```
   Expected output: `✓ unpaired — commands target the local daemon again.`

4. **Verify the CLI now targets the local daemon.**
   ```sh
   openagi doctor
   ```
   Expected: first check reads `local daemon → http://127.0.0.1:43210 (via local)`
   and the `daemon` check reads `reachable + authorized`.

5. **Repoint the Mac app's outreach consumer at the local daemon.**
   The menubar app's proactive-outreach feed may still point at the Distiller
   (UserDefaults `outreachRemoteURL`). Check, then repoint:
   ```sh
   defaults read app.openagi.daemon outreachRemoteURL
   defaults write app.openagi.daemon outreachRemoteURL "http://127.0.0.1:43210"
   defaults write app.openagi.daemon outreachToken "<OPENAGI_AUTH_TOKEN from ~/.openagi/.env — open the file yourself>"
   ```
   Then quit and relaunch the OpenAGI menubar app so `AppDelegate` reconfigures
   `OutreachConsumer` with the new URL.
   (If `defaults read` errors with "does not exist", outreach was never remote —
   still run the two `defaults write` commands so outreach notifications flow
   from the local brain.)

6. **Verify capture still lands locally (counts only).**
   ```sh
   TOKEN="<OPENAGI_AUTH_TOKEN from ~/.openagi/.env>"
   curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:43210/observations/stats
   ```
   Note the `activity` count, use the Mac for a minute, re-run: the count rises.

7. **Decide the Distiller's fate (separate decision, out of scope here).**
   The main at the old remote URL keeps its own memory/outcomes/integrations.
   Nothing on this Mac reads from it after steps 3–5. Options: keep it running
   as an independent install, or stop its daemon. Do not delete its data dir
   without a separate backup decision.

## Reversal

```bash
cp ~/.openagi/node.json.bak ~/.openagi/node.json
# or re-pair from scratch:
printf 'Main pairing token: ' >&2
IFS= read -rs OPENAGI_REMOTE_TOKEN; printf '\n' >&2
export OPENAGI_REMOTE_TOKEN
openagi pair https://<main-host>
unset OPENAGI_REMOTE_TOKEN
```

The main must have a trusted HTTPS origin for cross-device pairing. Plain HTTP
is supported only on loopback for same-machine development.

# Runbook: Pebble Index 01 → Peri (iPhone)

Talk to Peri from the ring with **Double click & hold**. Peri's reply appears in
a private chat in the iPhone app's Agent list. **Hold & talk** stays in Pebble
notes. The spec is
[developer.repebble.com/index-01/webhooks](https://developer.repebble.com/index-01/webhooks/).
The ring has only these two gestures; there is no triple click.

## Before you start

- The main daemon has `OPENAGI_AUTH_TOKEN` set and an `https://`
  `OPENAGI_PUBLIC_URL`, reached through a tunnel or a TLS reverse proxy
  (see `docs/setup/remote-channels.md`). The receiver refuses plain HTTP, and
  provisioning refuses a non-HTTPS public URL.
- The iPhone OpenAGI app is paired with that daemon.
- The Pebble app on the same iPhone is paired with Index 01.

## 1. Create the ring's URL and secret (do not share them)

1. On the Mac, sign in to `https://<public-origin>/connections`.
2. Under **Pebble Index 01 → Peri**, enter a ring name and tap **Add Index 01**.
3. The page shows the URL and a 32-byte signing secret **once**. Use **Copy URL**
   and **Copy secret**, and paste each straight into the Pebble app on the
   iPhone (Universal Clipboard works). You can also open the page in Safari on
   the iPhone.
4. Tap **Done** to clear them from the page.

Never paste the secret into Peri, iMessage, any other chat, an issue or a
screenshot. If it leaks, use **Rotate secret**, which issues a new secret and
disables the old one, then update the Pebble app. **Revoke** removes the ring.

## 2. Configure the Pebble app

In the Pebble app: Index 01 → Webhooks.

- **Double click & hold**: set the URL from step 1. Set the payload to
  **Transcription only** and turn on request signing with the secret from
  step 1. Do not add any custom headers.
- **Hold & talk**: leave it as it is. Do not point it at this URL. If you do,
  OpenAGI verifies those deliveries and drops them, and the Connections page
  shows "Hold & talk deliveries ignored".

## 3. Acceptance

1. **Test event.** In the gesture's settings, send a test event. Pebble's
   Recent runs should show success. On Connections, the ring should show
   "test verified <time>". The test event must not appear in any chat, note
   or memory.
2. **Normal request.** Double click & hold and say "What's on my calendar
   tomorrow?". A chat named after the ring appears in the iPhone app's Agent
   list, with your words and Peri's reply. This turn has no tools, so
   Peri may explain it can't check the calendar from the ring. That is
   expected. Nothing is saved.
3. **Note.** Say "Keep this note: parking is on level 3". The chat replies "Kept
   as a private Pebble note". Check it at `/pebble/peri/notes` while signed in.
4. **Memory.** Say "Remember this: the gate code is in the blue binder". The
   chat replies "Saved to private memory".
5. **Ambiguous.** Say "Can you remember this for me?". The chat replies "Nothing
   was saved".
6. **Retry.** Use Retry on a finished run in Recent runs. No second chat message
   appears.

## Limitations

- The ring is treated as untrusted input. A valid signature proves which ring
  sent the recording, not that you are the one speaking. Ring turns cannot run
  tools, approve or deny cards, or count as owner approval. Follow up by typing
  in the same iPhone chat. Those typed turns are yours, but they treat the
  ring's text as untrusted context.
- Only two spoken commands save anything: **"keep this note"** and **"remember
  this"**. Each must start the recording (an optional "Peri," before it is
  fine) and be followed by what to save. Anything else is never saved, and
  "remind me to…" does not create a task.
- Only transcripts are accepted. Recordings with audio (Recording only or
  Both) are rejected. The limits are 8,000 characters and a 64 KiB request.
- Notes are a private JSON log on the daemon at `/pebble/peri/notes`. They do
  not sync to Apple Notes or Pebble.
- Pebble retries failures for about 10 minutes. A request signed more than 5
  minutes earlier is rejected.
- The older `/webhooks/pebble` memo import is a separate feature. It saves
  every recording to memory, so don't use its URL for Peri.

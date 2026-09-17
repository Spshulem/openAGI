# Vocaleo phone calls

Vocaleo is an optional tool for OpenAGI. Each OpenAGI installation connects its
owner's Vocaleo account; no shared account or OpenAGI-managed phone service is
required. It works with any of OpenAGI's model providers.

1. Finish OpenAGI's initial setup, then open **Integrations → Vocaleo**.
2. Enter your own phone number with its country code (for example,
   `+14155550123`) and select **Text me a code**.
3. Enter the SMS code and select **Verify and connect**. Alternatively, expand
   **Already have a Vocaleo API key?** and connect with your existing key.
4. Check your connection and credit. Follow **Add Vocaleo credit** if needed.
5. In chat, supply a destination number, your name, and a task, including any
   facts the caller may state and acceptable alternatives. OpenAGI prepares a
   call for approval showing the current rate and temporary credit hold.
6. Approve it in the dashboard's Approvals tab. The assistant receives a call ID
   and can read its status, outcome, summary, transcript, and final charge.

Connecting enables the tools immediately. Disconnecting removes them immediately.
Neither action requires restarting OpenAGI. Your one-time key is stored in the
canonical OpenAGI data directory's `.env` (mode `0600`), alongside other integration
credentials. It is not returned to the browser or passed to the model. SMS codes
are not saved. Configuration loaded from `.env` at startup uses `VOCALEO_API_KEY`,
`VOCALEO_ACCOUNT_ID`, and optional `VOCALEO_PHONE_NUMBER`.

Verifying an existing account issues a new key and revokes its previous key.
Connect with the existing key to retain access from other clients. Disconnecting
OpenAGI only removes local credentials: it does not close the Vocaleo account,
cancel active calls, refund credit, or cancel a dedicated-number subscription.

Your setup number is for ownership verification, not the outgoing caller ID.
Vocaleo handles calling numbers. Its dedicated number is a separate optional
add-on managed with Vocaleo; this integration does not purchase one. An existing
active dedicated number is respected; an inactive number is disclosed in the
call approval before Vocaleo falls back to a shared number. Call forwarding and
automatic return-call monitoring are not provided by this integration.

Calls currently support the US, Canada, and UK. Vocaleo identifies the assistant
as AI on a recorded line. Call credit is billed by Vocaleo separately from the
OpenAGI model budget. Standard is the default; Pro is selected per call only
when requested. Rates and reserves come from the live account response.

Available tools:

| Tool | Behavior |
| --- | --- |
| `vocaleo_get_account` | Read balance, current rates, reserves, and payment link. |
| `vocaleo_start_call` | Prepare one call for approval and submit it after approval. |
| `vocaleo_get_call` | Read the call result; optionally wait up to 30 seconds. |

Each call attempt has an idempotency key saved with the pending approval. After
an uncertain submission, retry only with that same key and unchanged arguments.
Vocaleo replays the original call instead of dialing again. Queued or in-progress
is not a completed call. Read the returned call ID for the final result and charge.
Provider outages and rate limits do not trigger automatic account recovery,
resubmission, payments, or calls.

Private call-attempt records also live under `vocaleo/call-attempts/` in the
data directory, at mode `0600`. They preserve the original arguments for safe
retries across restarts, including when the first submission already held credit.

API contract: [Vocaleo OpenAPI](https://api.vocaleo.co/openapi.json) and
[Vocaleo documentation](https://vocaleo.co/docs).

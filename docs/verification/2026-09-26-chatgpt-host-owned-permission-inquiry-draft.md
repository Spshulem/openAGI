# OpenAI permission and protocol inquiry — draft / NO SEND

Status: **draft for the owner to review; NOT SENT**. No OpenAI contact, login, terms acceptance, purchase, credential entry, model request, private cache access or product-backend call occurred while preparing this document. This is not permission, legal advice or a production-readiness receipt. The relevant local candidate remains NO-GO; see [the candidate and verification boundary](2026-09-26-chatgpt-host-owned-candidate.md).

## Why written clarification is needed

The proposed `openai-chatgpt` adapter is an independent OpenAGI-owned OAuth device grant stored in the host's Secret Service. OpenAGI (not Codex SDK/app-server) would choose `https://chatgpt.com/backend-api/codex/responses` and execute its own filtered tools. It would not import another client's credentials. The [official Codex app-server documentation](https://developers.openai.com/codex/app-server) documents an experimental mode for externally supplied ChatGPT tokens, but does not describe obtaining an independent grant for a third-party application or a direct product-backend contract. The [CI authentication guide](https://developers.openai.com/codex/auth/ci-cd-auth) excludes generic OAuth clients outside Codex from its scope; the [standard API overview](https://developers.openai.com/api/reference/overview) documents separate API-key/workload-identity credentials. Public documentation and another application's working implementation are not authorization for this design. Applicable [European consumer terms](https://openai.com/policies/eu-terms-of-use/), [business/developer agreement](https://openai.com/policies/services-agreement/) and [service terms](https://openai.com/policies/service-terms/) require interpretation for the intended account and use; no agent should infer a legal permission or prohibition from technical reachability alone.

The [official support contact instructions](https://help.openai.com/en/articles/6614161-how-can-i-contact-support) name the help-center chat bubble. The owner or counsel may instead use an existing OpenAI account team or a more appropriate contractual channel. Do not transmit this draft or include an account email/ID without the owner's separate review and approval.

## Suggested inquiry (English; human review required)

Subject: Clarification of authorization and supported contract for a third-party ChatGPT/Codex OAuth integration

Hello OpenAI team,

We are evaluating a non-commercial, self-hosted integration in an application separate from the official Codex CLI, SDK and app-server. The application would obtain its **own** ChatGPT device-authorization grant, keep access and refresh tokens in the user's OS secret store, and make direct model requests to the ChatGPT/Codex product Responses backend, while executing application-owned tools under its own approvals. It would not import, share or copy any Codex client's existing credentials, and it would not use a ChatGPT token as an OpenAI API key. No login or model request has been made for this integration.

Could you please confirm in writing:

1. Whether this exact independently hosted OAuth flow and direct product Responses route are permitted for the intended ChatGPT plan and account category, and which agreement, documentation, client-registration process and restrictions govern it. If not supported, please identify the supported alternative that lets our application retain token and tool-loop ownership.
2. Whether a third-party host may use Codex's published OAuth client identifier for its *own* device grant, or must register and identify a distinct client; and whether access to the product backend is restricted to first-party/approved clients. Please provide the supported issuer, scopes, token audience, refresh/revocation rules, origin and route contract **without sending any credentials**.
3. Whether this route permits host-advertised function tools to be executed only by our application, and which per-account catalogue, allowed reasoning settings, quota and rate-limit surfaces are supported for an independent host. We understand that standard API-key model availability is not proof of ChatGPT subscription access.
4. Whether OpenAI offers a provider-defined, response-bound field that attests the **effective reasoning effort tier** and served model for each ChatGPT/Codex product response (including reroutes), rather than merely echoing requested configuration. If unavailable, please state that explicitly.
5. Whether the answer differs for private development, personal use, distribution of a non-commercial open-source client, and organizational deployment, and whether written approval, a separate commercial/API agreement or another integration architecture is required for each.

Please route this question to the appropriate product and terms owner if support cannot determine the applicable permissions or protocol contract. We can provide non-sensitive architecture details if requested; we will not send tokens, device codes, account caches, prompts or private logs.

Thank you.

## Acceptance boundary for any future reply

- Record the date, exact response, responder/authority and governing version/terms in a private human-reviewed record; keep account identifiers and confidential agreements out of Git. A generic support acknowledgement, technical success or a draft question does not approve the flow.
- If the reply supports only official Codex SDK/app-server, treat that as a *different custody/tool-boundary design*. Do not quietly reinterpret it as permission for the direct OpenAGI-owned route.
- If written permission applies only to a narrower use, record precisely that scope. Product permission does not prove local service sandbox, keyring, real account catalogue, entitlement, effective-effort semantics or safe tool execution.
- Until applicable permission and required technical evidence are separately reviewed, keep credential-bearing login, inference, setup/admin selection and activation blocked. A future user approval is scoped to its literal action and is not a substitute for upstream permission or qualification.

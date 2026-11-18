# OpenAGI mobile privacy policy

Effective November 1, 2026. OpenAGI is provided by Spencer Shulem.

## Your choice of agent

OpenAGI can run an agent on a supported phone, connect to a server you choose,
or use an optional cloud model provider. These choices determine where your
information is processed. A local agent does not require an OpenAGI account.

When you select the on-device model, inference is processed on your device.
Conversations, tasks, memories and settings are stored in the app's local
storage. Online integrations still contact the services you connect. Apple
Intelligence availability depends on your device, language, region and system
settings; see [Apple's privacy information](https://www.apple.com/privacy/).

When you select a cloud model, your messages and the context needed for your
request, which can include task content, memories and instructions, are sent
to that provider. The provider's terms, privacy policy and retention settings
apply. OpenAGI does not claim that cloud requests remain on your phone.

When you pair with a server, the app exchanges conversations, tasks, approvals,
settings and authentication information with that server. The server operator
controls its storage, model providers and integrations. A server may retain
your information after you disconnect the phone.

## Connected services and credentials

Integrations are optional. Connecting a service permits the agent to access
information within the access you grant, such as tasks, messages or calendar
information. Requests and authorized changes go to the connected service and,
when needed to answer your request, your selected model provider.

The app uses the system Keychain for saved phone credentials and model-provider
credentials. Your chosen server may also store the credentials it needs.
Disconnecting a service does not necessarily delete information already
retained by that service or your server. You can revoke access with the service.

## Optional notifications

On iOS, remote notifications use Apple Push Notification service and may use
OpenAGI's push relay, hosted on Cloudflare, or a relay selected by your server
operator. The relay handles device and Live Activity push tokens, encrypted
notification payloads and delivery metadata such as request timing, size and
IP address. It cannot decrypt the encrypted task and question content.

The relay does not persist raw registrations or log request bodies, tokens or
passes. Its encrypted authorization pass expires after 30 days. If revocation
storage is enabled, it retains a hash of a revoked pass until the pass expires
(with a minimum 60-second lifetime). Apple, Cloudflare and a self-hosted relay
operator process delivery and network information under their own policies.
Turning off notifications in system Settings stops notification presentation.

## Advertising, tracking and diagnostics

The mobile app does not contain advertising or cross-app tracking SDKs and
does not sell your personal information. There is no developer-operated
analytics or crash-reporting SDK in the mobile app. Apple may provide crash
or usage reports according to your system sharing choices. Information you
choose to send in a support request is used to address that request.

## Retention and deletion

Local information remains until you remove it or delete the app's data.
Keychain entries can survive an app uninstall. Use the app's disconnect,
revoke or remove-credential controls where available, and revoke provider or
server access when you no longer need it. Replaying onboarding keeps existing
pairings, models and conversations; it is not a data-erasure action.

To remove server data, contact the operator of that server. To remove data
held by a model provider or connected service, use that service's deletion
controls or contact it directly. Deleting a local copy does not delete those
remote copies.

## Contact and changes

For privacy questions or deletion requests concerning information you have
sent to the OpenAGI developer, email hello@contextlimit.llc. For general
support, visit [OpenAGI issues](https://github.com/Spshulem/openAGI/issues).
Do not post credentials or private conversations in public issues.

Changes to this policy will be published here with an updated effective date.

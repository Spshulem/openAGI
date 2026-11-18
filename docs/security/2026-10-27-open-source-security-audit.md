# OpenAGI security and source-release audit — 2026-10-27

## Result

No live credentials were confirmed in the checked source or locally reachable Git history. Two network-boundary defects were found and repaired locally: DNS rebinding against a tokenless daemon, and public hostnames being misclassified as private IP addresses by the mobile clients. The fixes are prepared separately against current main for PR delivery; installation and release are separate steps. This is a bounded source audit, not a certification that every execution path is secure.

The project is licensed under **PolyForm Noncommercial 1.0.0**. It is source-available with restrictions on commercial use; it is not OSI open source. No license change was made.

## Scope and evidence

- Checkout: `codex/mobile-apps`, starting at `ebe7de69bb331a6c3257365daef457a1f484b579`, including its pre-existing local changes. Unrelated work was preserved.
- Credential scan: 714 UTF-8 files, approximately 6.9 MB, from 740 tracked and non-ignored paths in the starting working tree. Checks covered common provider tokens, private-key markers, credential-bearing URLs, JWTs, and suspicious literal secret assignments. All nine candidates were synthetic fixtures or tests.
- History scan: 6,026 UTF-8 Git blobs, approximately 224 MB, across locally available refs (1,939 reachable commits). All 76 pattern candidates were in test code: synthetic redaction inputs, intentionally invalid URLs, or private-key delimiters surrounding keys generated at test runtime. No remote refs were refreshed, and unreachable objects were not scanned.
- Binary files, image metadata, archive contents, and eight historical blobs above 2 MB were outside the text scan. Ignored local credentials, personal runtime data, installed applications, GitHub secret settings, and published binaries were not read or validated.
- Manual review focused on iOS Keychain storage and pairing, mobile HTTP access policy and node permissions, server authentication/origin checks, enrollment limits, path/command guards, release packaging, license declarations, and production dependency manifests.
- Registry advisory checks: root `npm audit --omit=dev` returned zero known vulnerabilities. The wearable client's `pnpm audit --prod` returned one Zod advisory, assessed below. Native dependency advisory coverage was limited to source/manifest review.

## High-impact findings repaired

### SEC-01 — Tokenless daemon accepted attacker-controlled Host headers

**Impact: 7/10.** A browser capable of DNS rebinding could access private local API data and attempt state changes while the daemon was configured without an owner token.

- Location: `src/auth.js:131` (`checkRequestHost`), `src/hosted-interface.js:730` (request entry).
- Evidence before the fix: an isolated loopback daemon returned HTTP 200 for a private task read and `/setup` with `Host: attacker.example:<port>`. The existing origin check compared Origin against the same untrusted Host value, so matching attacker-controlled values were not a sufficient boundary.
- Trigger/adoption: a tokenless local installation, a hostile browser page, and a browser/network configuration that permits rebinding. Browser local-network protections can reduce exposure; they are not an application-side fix.
- Duration/recovery: exposure persists while the tokenless daemon is running. A refresh does not repair it, and disclosed content cannot be recovered. Configuring a strong owner token mitigates it.
- Fix: reject non-loopback Host authorities on tokenless requests before public routes, first-run setup, or the auth gate. Keep authenticated tailnet and reverse-proxy hostnames working.
- Verification: the new five-test regression file passes, both independently and in the focused 61-test server security/mobile suite. Tests cover attacker reads/writes, first-run setup, malformed authorities, valid loopback access, and authenticated external hostnames.
- Limit: this reproduces the vulnerable HTTP behavior; it does not demonstrate a complete browser/DNS attack or imply every browser permits one.

### SEC-02 — Mobile private-address checks discarded hostname labels

**Impact: 6/10 for the Android credential boundary; additional iOS defense.** An attacker-controlled public hostname could pass the private-network HTTP allowlist, allowing a misdirected pairing connection or a paired hostname whose DNS changes to send a long-lived node token over public cleartext HTTP.

- Locations: `mobile/ios/Sources/Transport/HostAllowlist.swift:53` and `:61`; `mobile/android/app/src/main/kotlin/sh/openagi/mobile/transport/HostAllowlist.kt:35`.
- Evidence: Swift used `split(...).compactMap { Int($0) }`; Kotlin used `split(".").mapNotNull { it.toIntOrNull() }`. Both discarded nonnumeric hostname labels. For example, `10.0.0.5.attacker.example` became the four numbers of a private address.
- Trigger/adoption: pairing or connecting through such a crafted hostname; ordinary literal LAN addresses are unaffected. An attacker needs control of the selected hostname/DNS or to induce the user to select it.
- Platform distinction: Android enables cleartext networking and relies on this allowlist. iOS ATS normally supplies another barrier for public HTTP domains, so this was not independently demonstrated as an iOS credential leak. The shared parsing defect is repaired in both clients.
- Duration/recovery: a disclosed node token remains useful until revoked. Retrying or refreshing does not rotate it; affected users would need to revoke and pair again.
- Fix: require exactly four nonempty ASCII decimal labels and valid octet values, without dropping any labels. Preserve the existing LAN/tailnet policy and iOS CGNAT refusal.
- Regression coverage: both native HostAllowlist test files now reject public names containing private-IP labels, including numeric labels embedded among hostname labels.
- Validation: eight Swift XCTest cases and eight Kotlin/JUnit cases passed against the real policy source and committed test files, compiled in isolated standalone test harnesses. Only the transport error type was stubbed. These are policy tests, not full native application or device tests.

## Other findings and dispositions

### OSS-01 — License does not match an unrestricted open-source goal

- Evidence: `LICENSE:1` names PolyForm Noncommercial; `README.md:589` describes the restriction; `package.json` and the Docker image metadata point to that license.
- Consequence: contributors and downstream users cannot assume commercial reuse rights typical of an OSI-approved license. If unrestricted open source is the intended distribution model, the current license does not meet that goal.
- Disposition: recorded as a licensing/product decision, not a security vulnerability. Changing license terms requires an explicit owner decision and consideration of contribution rights; this audit does not relicense the project or certify legal compliance.

### DEP-01 — Wearable client declares an affected Zod release

- Location: `integration-clients/even-g2-overlay/package.json:33`, lockfile pin `zod@4.4.3`.
- Advisory: [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), reported high by the registry; patched in `4.6.6` or later. Oversized invalid arrays can cause excessive validation work/allocation.
- Application assessment: below the 6/10 implementation threshold for the reviewed paths. Live speech rejects messages above 128,000 characters before JSON/Zod parsing; the source uses array length bounds and accepts speech from the selected main/provider. Stored history/configuration has a different, local input boundary. Schema length checks alone are not proof that the vulnerable library avoids all work.
- Recovery: a transient client failure can require reopening the client; no credential disclosure or irreversible action was established from this advisory.
- Disposition: recorded, dependency unchanged. The root daemon's production dependency check is clean. This is not a clean advisory result for every subproject.

## Credential and distribution observations

- No provider API key, signing private key, shared universal node token, or service account credential was found embedded in the iOS source. Pairing creates a per-phone random token and stores it through Keychain, not with the task snapshot (`Credentials.swift:59`). Its default textual description redacts the token.
- Keychain uses `kSecAttrAccessibleAfterFirstUnlock`, enabling background access after the first unlock. The audit did not verify backup/restore behavior or shared Keychain entitlements on a physically signed device.
- Enrollment codes are cryptographically random, single use, platform-bound, expire after 30 minutes, and have five-attempt/15-minute lockout controls (`src/node-enrollment.js`). Mobile token routes are enumerated in `src/mobile-node.js`; the focused integration tests verify excluded routes remain inaccessible with a phone token on an authenticated daemon.
- The iOS client uses the platform TLS implementation; no custom certificate-validation bypass was found. HTTP on permitted LAN addresses is intentionally unencrypted at the application layer. Tailscale protection depends on the actual network route; a hostname suffix alone does not prove encryption. HTTPS is available for deployments that need transport protection outside that boundary.
- Mac signing/notarization values are referenced through CI secrets, rather than literal keys in the reviewed workflow. Runtime packaging selects source/example/script directories and locked production dependencies rather than copying the entire checkout. No built release artifact was inspected.
- iOS declares system frameworks rather than a separate third-party package dependency graph. This review is not a complete third-party notice/SBOM audit of Android, macOS, the wearable SDK, or distributed binaries.

## Verification and delivery status

- Server security/mobile regression suite: **61 passed, zero failed**, approximately 8.3 seconds. New Host guard regression file passed independently as well.
- Native host-policy tests: **8 Swift + 8 Kotlin passed**, zero failures, using standalone macOS/JVM harnesses with the real policy source and committed test files. No external dependencies were installed for these harnesses.
- Total focused coverage: **77 passing tests**. This is not a full-project test result.
- `git diff --check`: passed.
- PR preparation: ported only the fixes and regression tests onto main `2b11871`, preserving the newer Bonjour `.local` policy, normalized server origins, and embedded iOS daemon exception. The original audit and its 77-test result above describe the starting checkout; final-branch verification is recorded in the PR.
- No full monorepo/CI build, iOS simulator/device run, Android device run, merge, installation, or release was performed. Final publication and merge state are recorded in the PR.
- No live credential was tested against a provider, no secret was rotated, and no Git history was rewritten. Registry lookups used dependency metadata only.

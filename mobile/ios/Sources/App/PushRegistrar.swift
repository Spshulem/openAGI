import ActivityKit
import CryptoKit
import Foundation
import Security
import UIKit
import UserNotifications

// Registers this phone for supervisor pushes (the spec's "PushRegistrar"):
//
//   1. after pairing, ask for notification permission and an APNs device
//      token, and listen for the Live Activity push-to-start token;
//   2. trade the tokens at the relay for a `pass` (the device token alone is
//      enough: alerts never wait on Live Activities), and keep it;
//   3. hand `pass` + this phone's push key to its own daemon.
//
// Step 2 reruns only when a token, the relay or the APNs environment
// changed, and the pass is saved the moment the relay returns it, so a
// failed step 3 retries without minting another relay channel. Step 3 runs on
// every sync (foreground, background refresh, token arrival): re-posting the
// same pass is idempotent daemon-side and repairs a daemon that lost its
// record. Nothing here ever blocks the app: push is an extra, not a gate.
@MainActor
final class PushRegistrar {
    static let shared = PushRegistrar()

    // The relay must call the APNs host matching the device token or every
    // send fails with BadDeviceToken. Which one the token is for comes from
    // aps-environment in the signing profile, not the build configuration.
    static let env = environment(profile: Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision")
        .flatMap { try? Data(contentsOf: $0) })

    // App Store builds carry no profile and are production. A profile is a
    // signed blob around a plist; only the plist is read.
    nonisolated static func environment(profile: Data?) -> String {
        guard let profile else {
            #if targetEnvironment(simulator)
            return "sandbox"
            #else
            return "production"
            #endif
        }
        guard let start = profile.range(of: Data("<?xml".utf8)),
              let end = profile.range(of: Data("</plist>".utf8), in: start.lowerBound..<profile.endIndex),
              let plist = try? PropertyListSerialization.propertyList(from: profile[start.lowerBound..<end.upperBound],
                                                                      format: nil) as? [String: Any],
              let entitlements = plist["Entitlements"] as? [String: Any],
              let aps = entitlements["aps-environment"] as? String
        else { return "sandbox" }
        return aps == "production" ? "production" : "sandbox"
    }

    private enum Keys {
        static let deviceToken = "push.deviceToken"
        static let startToken = "push.startToken"
    }

    enum Step: Equatable {
        case idle
        // Get a new pass, then retire `replacing` (best effort) and post.
        case register(replacing: String?)
        case post(pass: String)
    }

    private let defaults: UserDefaults
    private let session: URLSession
    private let savePass: (PushPassStore.Stored) -> Bool
    private var startTokenTask: Task<Void, Never>?
    private var activityTask: Task<Void, Never>?
    // Order this process first saw each activity in; the newest one is kept.
    private var activityFirstSeen: [String: Int] = [:]
    private var syncTask: Task<Void, Never>?
    private var syncAgain = false
    // Bumped by forget(). A sync started under an older generation stops at
    // its next step instead of saving a pass or posting to the daemon.
    private var generation = 0
    // Pairings already forgotten. Credentials outlive forget() for a moment
    // (AppModel still revokes, then clears them); no sync may restart for
    // them in that window.
    private var forgottenNodeIDs: Set<String> = []

    init(defaults: UserDefaults = .standard, session: URLSession = .shared,
         savePass: @escaping (PushPassStore.Stored) -> Bool = PushPassStore.save) {
        self.defaults = defaults
        self.session = session
        self.savePass = savePass
    }

    // Called once a pairing exists (RootTabView appears). Safe to call again.
    func start() async {
        guard Credentials.load() != nil else { return }
        SupervisorCategories.register(SupervisorCategories.base())
        // Not awaited: whatever the answer, the device token is asked for. A
        // Live Activity started by push needs no notification permission.
        // The answer changes `alerts`, so it is reported once given; the sync
        // below runs before the owner has tapped Allow.
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
            Task { @MainActor in await PushRegistrar.shared.sync() }
        }
        UIApplication.shared.registerForRemoteNotifications()
        observeStartTokens()
        observeActivities()
        await sync()
    }

    func didRegister(deviceToken: Data) {
        defaults.set(deviceToken.hexString, forKey: Keys.deviceToken)
        Task { await sync() }
    }

    private func didReceive(startToken: Data) {
        defaults.set(startToken.hexString, forKey: Keys.startToken)
        Task { await sync() }
    }

    private func observeStartTokens() {
        guard startTokenTask == nil else { return }
        startTokenTask = Task { [weak self] in
            for await token in Activity<SupervisorActivityAttributes>.pushToStartTokenUpdates {
                self?.didReceive(startToken: token)
            }
        }
    }

    // A token rotation or a daemon restart can leave two activities on the
    // lock screen. Only the newest one gets the channel's next update, so
    // every older one is ended.
    private func observeActivities() {
        guard activityTask == nil else { return }
        endOlderActivities()
        // Detached so the non-Sendable Activity never leaves this task; only
        // its id hops to the main actor.
        activityTask = Task.detached { [weak self] in
            for await activity in Activity<SupervisorActivityAttributes>.activityUpdates {
                let id = activity.id
                await self?.noteActivity(id: id)
            }
        }
    }

    private func noteActivity(id: String) {
        if activityFirstSeen[id] == nil { activityFirstSeen[id] = activityFirstSeen.count }
        endOlderActivities()
    }

    private func endOlderActivities() {
        let live = Activity<SupervisorActivityAttributes>.activities
            .filter { $0.activityState == .active || $0.activityState == .stale }
        let ending = Set(Self.activityIDsToEnd(current: live.map(\.id), firstSeen: activityFirstSeen))
        guard !ending.isEmpty else { return }
        Task { await Self.endActivities(ids: ending) }
    }

    // Nonisolated, so each Activity is fetched and ended in one isolation
    // domain and never sent across. nil ends every one.
    nonisolated private static func endActivities(ids: Set<String>?) async {
        for activity in Activity<SupervisorActivityAttributes>.activities where ids?.contains(activity.id) ?? true {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }

    // The retry entry point (foreground, background refresh, token arrival).
    // Overlapping calls fold into one follow-up run instead of racing two
    // relay registrations.
    func sync() async {
        guard !Task.isCancelled else { return }
        if let running = syncTask {
            syncAgain = true
            await withTaskCancellationHandler {
                await running.value
            } onCancel: {
                running.cancel()
            }
            return
        }
        let task = Task { [weak self] in
            guard let self else { return }
            repeat {
                self.syncAgain = false
                await self.syncOnce()
            } while self.syncAgain && !Task.isCancelled
        }
        syncTask = task
        await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }
        syncTask = nil
    }

    private func syncOnce() async {
        let started = generation
        guard !Task.isCancelled, let credentials = Credentials.load(), !forgottenNodeIDs.contains(credentials.nodeID) else { return }
        // Checked after every await: forget() may have run meanwhile.
        func stillCurrent() -> Bool {
            !Task.isCancelled && Self.isCurrent(started: started, now: generation, startedNodeID: credentials.nodeID,
                           currentNodeID: Credentials.load()?.nodeID, forgotten: forgottenNodeIDs)
        }
        let deviceToken = defaults.string(forKey: Keys.deviceToken)
        // Live Activities switched off in Settings: register as alerts-only
        // rather than hand the relay a token that can start nothing.
        let startToken = ActivityAuthorizationInfo().areActivitiesEnabled ? defaults.string(forKey: Keys.startToken) : nil
        let relay = PushRelayClient(session: session)
        let signature = deviceToken.map {
            Self.signature(deviceToken: $0, startToken: startToken, env: Self.env, relay: relay.base)
        }
        let stored = PushPassStore.load()

        var current: PushPassStore.Stored
        var minted = false
        switch Self.step(paired: true, signature: signature, stored: stored, now: Date()) {
        case .idle:
            return
        case .post:
            guard let stored else { return }
            current = stored
        case let .register(replacing):
            // Do not overwrite an earlier retirement that still needs a retry.
            if let older = stored?.retire, older != replacing {
                do { try await relay.unregister(pass: older) } catch { return }
                guard stillCurrent() else { return }
            }
            guard let deviceToken, let signature,
                  let fresh = try? await relay.register(deviceToken: deviceToken, startToken: startToken, env: Self.env)
            else { return }
            guard stillCurrent() else {
                // Forgotten while the relay answered: retire what it made.
                try? await relay.unregister(pass: fresh)
                return
            }
            // The replaced pass waits until the daemon holds the new one.
            current = .init(pass: fresh, signature: signature, mintedAt: Date(), retire: replacing)
            // Saved before the daemon step, so a failed POST retries with it.
            // Not durable means the next run mints yet another channel, so the
            // fresh one is retired and nothing is posted.
            guard savePass(current) else {
                try? await relay.unregister(pass: fresh)
                return
            }
            minted = true
        }

        // Re-read every sync: turning notifications on later flips it.
        let alerts = Self.alertsAllowed(await Self.notificationAuthorization())
        guard stillCurrent(), let key = try? PushKeyStore.loadOrCreate() else { return }
        let client = DaemonClient(server: credentials.server, nodeID: credentials.nodeID, token: credentials.token, session: session)
        // Activities on the lock screen now belong to the pass being retired;
        // taken before the daemon learns the new pass and can start another.
        if current.retire != nil, current.retiringActivityIDs == nil {
            // Persist the snapshot before the daemon can start a new activity.
            // A retry, including after relaunch, must never end that new one.
            current.retiringActivityIDs = Activity<SupervisorActivityAttributes>.activities.map(\.id)
            guard savePass(current) else { return }
        }
        let oldActivityIDs = Set(current.retiringActivityIDs ?? [])
        // A failure here is retried on the next sync with the same pass.
        guard let result = try? await client.registerPush(pass: current.pass, key: key.base64URLEncodedString(),
                                                         env: Self.env, activities: startToken != nil, alerts: alerts),
              stillCurrent()
        else { return }

        if let retire = current.retire {
            // The daemon starts afresh on the new pass and the old channel is
            // about to go, so nothing else could end these.
            if !oldActivityIDs.isEmpty { await Self.endActivities(ids: oldActivityIDs) }
            do { try await relay.unregister(pass: retire) } catch { return }
            guard stillCurrent() else { return }
            current.retire = nil
            current.retiringActivityIDs = nil
            guard savePass(current) else { return }
        }
        if Self.shouldRenew(daemonSaysRenew: result.renew, justMinted: minted) {
            // Persisted as "too old", so the next run (now, or after a kill)
            // mints a fresh pass.
            current.mintedAt = nil
            guard savePass(current) else { return }
            syncAgain = true
        }
    }

    // Clear local push state before returning to credential revocation.
    // Network cleanup is best effort and must not delay that revocation.
    // Tokens are kept: they belong to the phone, not the pairing.
    func forget(client: DaemonClient, relay: PushRelayClient = PushRelayClient()) async {
        generation += 1
        if let nodeID = Credentials.load()?.nodeID { forgottenNodeIDs.insert(nodeID) }
        // Cancel and wait out an in-flight sync, so it cannot save a pass or
        // post to the daemon after the cleanup below.
        if let running = syncTask {
            running.cancel()
            await running.value
        }
        let stored = PushPassStore.load()
        PushPassStore.clear()
        PushKeyStore.clear()
        await Self.endActivities(ids: nil)
        let center = UNUserNotificationCenter.current()
        center.removeAllDeliveredNotifications()
        center.removeAllPendingNotificationRequests()
        // Capture only this pairing's client and passes. A later pairing is
        // independent even if the relay is unavailable until its timeout.
        Task {
            try? await client.unregisterPush()
            if let stored {
                try? await relay.unregister(pass: stored.pass)
                if let retire = stored.retire { try? await relay.unregister(pass: retire) }
            }
        }
    }

    // MARK: - Pure decisions (pinned by tests)

    // A pass is re-minted well inside the relay's 30-day expiry.
    nonisolated static let passMaxAge: TimeInterval = 7 * 24 * 60 * 60

    // `signature` is nil until there is a device token. A pass with no mint
    // date (saved before dates were kept, or marked for renewal) is too old.
    nonisolated static func step(paired: Bool, signature: String?, stored: PushPassStore.Stored?, now: Date) -> Step {
        guard paired, let signature else { return .idle }
        guard let stored else { return .register(replacing: nil) }
        guard stored.signature == signature,
              let mintedAt = stored.mintedAt, now.timeIntervalSince(mintedAt) < passMaxAge
        else { return .register(replacing: stored.pass) }
        return .post(pass: stored.pass)
    }

    // A pass minted this run cannot already be refused; asking again would
    // loop.
    nonisolated static func shouldRenew(daemonSaysRenew: Bool, justMinted: Bool) -> Bool {
        daemonSaysRenew && !justMinted
    }

    nonisolated static func alertsAllowed(_ status: UNAuthorizationStatus) -> Bool {
        switch status {
        case .authorized, .provisional, .ephemeral: return true
        default: return false
        }
    }

    // Completion-handler API: only the Sendable status leaves the callback.
    nonisolated private static func notificationAuthorization() async -> UNAuthorizationStatus {
        await withCheckedContinuation { (continuation: CheckedContinuation<UNAuthorizationStatus, Never>) in
            UNUserNotificationCenter.current().getNotificationSettings { settings in
                continuation.resume(returning: settings.authorizationStatus)
            }
        }
    }

    // Whether a sync that started under `started` may take its next step.
    nonisolated static func isCurrent(started: Int, now: Int, startedNodeID: String,
                                      currentNodeID: String?, forgotten: Set<String>) -> Bool {
        started == now && currentNodeID == startedNodeID && !forgotten.contains(startedNodeID)
    }

    // Keeps the newest: first seen latest in this process, and among ones
    // this process never saw start, the last the system lists.
    nonisolated static func activityIDsToEnd(current: [String], firstSeen: [String: Int]) -> [String] {
        guard current.count > 1 else { return [] }
        let ranked = current.enumerated().map { index, id in (id: id, rank: (firstSeen[id] ?? -1, index)) }
        guard let newest = ranked.max(by: { $0.rank < $1.rank }) else { return [] }
        return current.filter { $0 != newest.id }
    }

    // Everything a relay registration depends on, hashed so the stored value
    // says nothing about the tokens.
    nonisolated static func signature(deviceToken: String, startToken: String?, env: String, relay: URL) -> String {
        let joined = [deviceToken, startToken ?? "", env, relay.absoluteString].joined(separator: "\n")
        return SHA256.hash(data: Data(joined.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

// The current relay pass and the registration it came from, in the keychain
// (it lets anyone holding it push to this phone through the relay). App-only:
// the extensions never need it.
enum PushPassStore {
    struct Stored: Codable, Equatable, Sendable {
        var pass: String
        var signature: String
        var mintedAt: Date?
        // The pass this one replaced, unregistered at the relay once the
        // daemon holds the new one.
        var retire: String?
        var retiringActivityIDs: [String]?

        init(pass: String, signature: String, mintedAt: Date? = nil, retire: String? = nil,
             retiringActivityIDs: [String]? = nil) {
            self.pass = pass
            self.signature = signature
            self.mintedAt = mintedAt
            self.retire = retire
            self.retiringActivityIDs = retiringActivityIDs
        }
    }

    private static let service = "sh.openagi.mobile.pushpass"
    private static let account = "primary"

    static func load() -> Stored? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(Stored.self, from: data)
    }

    // Updated in place, so a failed write never loses the pass already stored.
    @discardableResult
    static func save(_ stored: Stored) -> Bool {
        guard let data = try? JSONEncoder().encode(stored) else { return false }
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let updated = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        guard updated == errSecItemNotFound else { return updated == errSecSuccess }
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    static func clear() {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ] as CFDictionary)
    }
}

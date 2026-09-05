/// A failed health probe cannot establish whether credentials are configured.
/// Keep recovery separate from onboarding, including after a previously valid
/// health response becomes stale.
enum ProviderSetupStatus: Equatable {
  case unknown
  case configured
  case needsSetup

  static func resolve(daemonResponding: Bool, configured: Bool?) -> Self {
    guard daemonResponding, let configured else { return .unknown }
    return configured ? .configured : .needsSetup
  }
}

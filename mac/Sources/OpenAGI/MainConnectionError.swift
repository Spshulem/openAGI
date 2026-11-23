import Foundation

// Fixed, actionable copy for a worker whose main connection needs repair.
// Never present the upstream response body as instructions or imply the
// phone's enrollment was revoked by a missing worker grant.
struct MainConnectionError: LocalizedError {
  let code: String

  var errorDescription: String? {
    switch code {
    case "main-pairing-required":
      return "Main workspace authorization is needed. Reconnect this Mac safely by running `openagi reconnect`, then approve the one-time request from an already paired owner phone. The node heartbeat, phone pairing, and saved work are kept."
    case "main-routing-loop":
      return "This Mac's main address points to another worker. Correct its main server address, then refresh."
    default:
      return "This Mac can't reach main. Check the main server and network connection, then refresh. Saved work and pairing are kept."
    }
  }

  static func decode(statusCode: Int, data: Data) -> MainConnectionError? {
    guard statusCode == 502 || statusCode == 508,
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let code = object["error"] as? String,
          ["main-pairing-required", "main-unavailable", "main-routing-loop"].contains(code) else { return nil }
    return MainConnectionError(code: code)
  }
}

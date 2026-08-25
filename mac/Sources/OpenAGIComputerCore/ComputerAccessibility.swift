import AppKit
import ApplicationServices
import Foundation

public enum ComputerAccessibilityError: LocalizedError {
  case unavailable
  case staleElement
  case secureElement
  case unsupportedAction
  case invalidValue
  case ambiguousText
  case clipboardFailed

  public var errorDescription: String? {
    switch self {
    case .unavailable: return "the focused Accessibility tree is unavailable"
    case .staleElement: return "the referenced element changed; take a fresh computer state"
    case .secureElement: return "computer input into password or secure text elements is not allowed"
    case .unsupportedAction: return "the requested Accessibility action is not exposed by this element"
    case .invalidValue: return "the requested Accessibility value is invalid or was not confirmed by readback"
    case .ambiguousText: return "the requested text selection is missing or ambiguous"
    case .clipboardFailed: return "the pasteboard could not be safely updated"
    }
  }
}

public struct ComputerAccessibilityElement: Codable, Equatable {
  public let index: Int
  public let path: [Int]
  public let role: String
  public let subrole: String?
  public let identifier: String?
  public let title: String?
  public let value: String?
  public let x: Double?
  public let y: Double?
  public let width: Double?
  public let height: Double?
  public let actions: [String]
  public let secure: Bool

  public init(index: Int, path: [Int], role: String, subrole: String? = nil,
              identifier: String? = nil, title: String? = nil, value: String? = nil,
              frame: CGRect? = nil, actions: [String] = [], secure: Bool = false) {
    self.index = index
    self.path = path
    self.role = role
    self.subrole = subrole
    self.identifier = identifier
    self.title = title
    self.value = value
    self.x = frame.map { Double($0.origin.x) }
    self.y = frame.map { Double($0.origin.y) }
    self.width = frame.map { Double($0.width) }
    self.height = frame.map { Double($0.height) }
    self.actions = actions
    self.secure = secure
  }

  public var frame: CGRect? {
    guard let x, let y, let width, let height,
          [x, y, width, height].allSatisfy({ $0.isFinite }), width > 0, height > 0 else { return nil }
    return CGRect(x: x, y: y, width: width, height: height)
  }
}

public struct ComputerAccessibilitySnapshot: Codable, Equatable {
  public let text: String
  public let elements: [ComputerAccessibilityElement]
  public let truncated: Bool
}

public enum ComputerAccessibility {
  public static let maximumNodes = 2_000
  public static let maximumTextBytes = 96 * 1024
  public static let maximumElementBytes = 4 * 1024 * 1024

  public static func capture(
    focus: ComputerFocusIdentity,
    maxNodes: Int = maximumNodes,
    maxTextBytes: Int = maximumTextBytes,
    maxElementBytes: Int = maximumElementBytes
  ) throws -> ComputerAccessibilitySnapshot {
    guard maxNodes > 0, maxNodes <= maximumNodes,
          maxTextBytes > 0, maxTextBytes <= maximumTextBytes,
          maxElementBytes > 0, maxElementBytes <= maximumElementBytes,
          ComputerScreenshot.focusStillMatches(focus),
          let root = focusedWindow(processIdentifier: focus.processIdentifier) else {
      throw ComputerAccessibilityError.unavailable
    }
    var elements: [ComputerAccessibilityElement] = []
    var lines: [String] = []
    var textBytes = 0
    var elementBytes = 0
    var truncated = false

    func walk(_ element: AXUIElement, path: [Int], depth: Int) {
      guard !truncated else { return }
      guard elements.count < maxNodes, depth <= 32 else { truncated = true; return }
      let role = bounded(stringAttribute(element, kAXRoleAttribute as CFString), 120) ?? "AXUnknown"
      let subrole = bounded(stringAttribute(element, kAXSubroleAttribute as CFString), 120)
      let identifier = bounded(stringAttribute(element, kAXIdentifierAttribute as CFString), 240)
      let title = firstText(element)
      let secure = isSecure(role: role, subrole: subrole)
      let value = secure ? nil : bounded(stringAttribute(element, kAXValueAttribute as CFString), 2_000)
      let frame = elementFrame(element)
      let actions = actionNames(element).prefix(32).map { bounded($0, 120) ?? "" }.filter { !$0.isEmpty }
      let locator = ComputerAccessibilityElement(
        index: elements.count, path: path, role: role, subrole: subrole,
        identifier: identifier, title: title, value: value, frame: frame,
        actions: Array(actions), secure: secure
      )
      var parts = ["[\(locator.index)]", role]
      if let title, !title.isEmpty { parts.append("\"\(escaped(title))\"") }
      if let value, value != title { parts.append("value=\"\(escaped(value))\"") }
      if secure { parts.append("value=<redacted>") }
      if !locator.actions.isEmpty { parts.append("actions=\(locator.actions.joined(separator: ","))") }
      if let frame {
        parts.append("frame=(\(Int(frame.origin.x)),\(Int(frame.origin.y)),\(Int(frame.width)),\(Int(frame.height)))")
      }
      let line = String(repeating: "  ", count: min(depth, 12)) + parts.joined(separator: " ")
      let lineBytes = line.utf8.count + 1
      let locatorBytes = ((try? JSONEncoder().encode(locator).count) ?? maxElementBytes) + 1
      guard textBytes + lineBytes <= maxTextBytes,
            elementBytes + locatorBytes <= maxElementBytes else { truncated = true; return }
      elements.append(locator)
      lines.append(line)
      textBytes += lineBytes
      elementBytes += locatorBytes

      for (childIndex, child) in children(element).enumerated() {
        if elements.count >= maxNodes { truncated = true; break }
        walk(child, path: path + [childIndex], depth: depth + 1)
      }
    }

    walk(root, path: [], depth: 0)
    if truncated {
      let marker = "[truncated: Accessibility state reached its safety limit]"
      if textBytes + marker.utf8.count + 1 <= maxTextBytes { lines.append(marker) }
    }
    return ComputerAccessibilitySnapshot(text: lines.joined(separator: "\n"),
                                         elements: elements, truncated: truncated)
  }

  public static func click(
    locator: ComputerAccessibilityElement,
    focus: ComputerFocusIdentity,
    cancellation: ComputerInputCancellation? = nil
  ) throws {
    let element = try resolve(locator: locator, focus: focus)
    try cancellation?.check()
    if locator.actions.contains(kAXPressAction as String) {
      guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else {
        throw ComputerAccessibilityError.unsupportedAction
      }
      return
    }
    guard let frame = locator.frame else { throw ComputerAccessibilityError.unsupportedAction }
    try ComputerInput.click(x: Double(frame.midX), y: Double(frame.midY), button: "left",
                            focus: focus, cancellation: cancellation)
  }

  public static func setValue(
    locator: ComputerAccessibilityElement,
    value: String,
    focus: ComputerFocusIdentity,
    cancellation: ComputerInputCancellation? = nil
  ) throws {
    guard value.utf8.count <= 16 * 1024, !value.contains("\0") else {
      throw ComputerAccessibilityError.invalidValue
    }
    let element = try resolveEditable(locator: locator, focus: focus, cancellation: cancellation)
    var settable = DarwinBoolean(false)
    guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success,
          settable.boolValue,
          AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString) == .success,
          stringAttribute(element, kAXValueAttribute as CFString) == value else {
      throw ComputerAccessibilityError.invalidValue
    }
  }

  public static func performSecondaryAction(
    locator: ComputerAccessibilityElement,
    action: String,
    focus: ComputerFocusIdentity,
    cancellation: ComputerInputCancellation? = nil
  ) throws {
    guard !action.isEmpty, action.utf8.count <= 120, !action.contains("\0"),
          action != (kAXPressAction as String), locator.actions.contains(action) else {
      throw ComputerAccessibilityError.unsupportedAction
    }
    let element = try resolve(locator: locator, focus: focus)
    try cancellation?.check()
    guard AXUIElementPerformAction(element, action as CFString) == .success else {
      throw ComputerAccessibilityError.unsupportedAction
    }
  }

  public static func selectText(
    locator: ComputerAccessibilityElement,
    text: String,
    prefix: String?,
    suffix: String?,
    selectionType: String,
    focus: ComputerFocusIdentity,
    cancellation: ComputerInputCancellation? = nil
  ) throws {
    guard !text.isEmpty, text.utf8.count <= 16 * 1024,
          [prefix, suffix].compactMap({ $0 }).allSatisfy({ $0.utf8.count <= 4 * 1024 }),
          ["text", "cursor_before", "cursor_after"].contains(selectionType) else {
      throw ComputerAccessibilityError.ambiguousText
    }
    let element = try resolveEditable(locator: locator, focus: focus, cancellation: cancellation)
    guard let content = stringAttribute(element, kAXValueAttribute as CFString),
          content.utf8.count <= 256 * 1024 else { throw ComputerAccessibilityError.ambiguousText }
    let found = try uniqueTextRange(content: content, text: text, prefix: prefix, suffix: suffix)
    var selected = CFRange(
      location: selectionType == "cursor_after" ? found.location + found.length : found.location,
      length: selectionType == "text" ? found.length : 0
    )
    guard let rangeValue = AXValueCreate(.cfRange, &selected),
          AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, rangeValue) == .success else {
      throw ComputerAccessibilityError.ambiguousText
    }
  }

  public static func paste(
    locator: ComputerAccessibilityElement,
    text: String,
    format: String,
    focus: ComputerFocusIdentity,
    cancellation: ComputerInputCancellation? = nil
  ) throws {
    guard text.utf8.count <= 64 * 1024, !text.contains("\0"),
          ["text", "md", "html"].contains(format) else { throw ComputerAccessibilityError.invalidValue }
    let element = try resolveEditable(locator: locator, focus: focus, cancellation: cancellation)
    try focusElement(element)
    let pasteboard = NSPasteboard.general
    let saved = try snapshotPasteboard(pasteboard)
    var temporaryChangeCount: Int?
    defer {
      if let temporaryChangeCount {
        restorePasteboard(pasteboard, saved: saved, expectedChangeCount: temporaryChangeCount)
      }
    }
    pasteboard.clearContents()
    temporaryChangeCount = pasteboard.changeCount
    let item = NSPasteboardItem()
    let type: NSPasteboard.PasteboardType = format == "html"
      ? .html
      : format == "md" ? NSPasteboard.PasteboardType("net.daringfireball.markdown") : .string
    guard item.setString(text, forType: type),
          (type == .string || item.setString(text, forType: .string)),
          pasteboard.writeObjects([item]) else { throw ComputerAccessibilityError.clipboardFailed }
    temporaryChangeCount = pasteboard.changeCount
    try ComputerInput.sendShortcut("cmd+v", focus: focus, cancellation: cancellation)
    Thread.sleep(forTimeInterval: 0.1)
  }

  public static func scroll(
    locator: ComputerAccessibilityElement,
    direction: String,
    pages: Int,
    focus: ComputerFocusIdentity,
    cancellation: ComputerInputCancellation? = nil
  ) throws {
    guard let frame = locator.frame, (1...10).contains(pages),
          ["up", "down", "left", "right"].contains(direction) else {
      throw ComputerAccessibilityError.invalidValue
    }
    _ = try resolve(locator: locator, focus: focus)
    let amount = Int32(pages * 8)
    let deltaX: Int32 = direction == "left" ? amount : direction == "right" ? -amount : 0
    let deltaY: Int32 = direction == "up" ? amount : direction == "down" ? -amount : 0
    try ComputerInput.scroll(x: Double(frame.midX), y: Double(frame.midY),
                             deltaX: deltaX, deltaY: deltaY,
                             focus: focus, cancellation: cancellation)
  }

  public static func focusedElementIsSecure(processIdentifier: pid_t) throws -> Bool {
    let application = AXUIElementCreateApplication(processIdentifier)
    var raw: AnyObject?
    guard AXUIElementCopyAttributeValue(application, kAXFocusedUIElementAttribute as CFString, &raw) == .success,
          let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else {
      throw ComputerAccessibilityError.unavailable
    }
    let element = raw as! AXUIElement
    return isSecure(role: stringAttribute(element, kAXRoleAttribute as CFString) ?? "",
                    subrole: stringAttribute(element, kAXSubroleAttribute as CFString))
  }

  private static func resolveEditable(
    locator: ComputerAccessibilityElement,
    focus: ComputerFocusIdentity,
    cancellation: ComputerInputCancellation?
  ) throws -> AXUIElement {
    guard !locator.secure else { throw ComputerAccessibilityError.secureElement }
    try cancellation?.check()
    return try resolve(locator: locator, focus: focus)
  }

  private static func resolve(locator: ComputerAccessibilityElement,
                              focus: ComputerFocusIdentity) throws -> AXUIElement {
    try ComputerInput.requireActionTimeReadiness(focus: focus)
    guard ComputerScreenshot.focusStillMatches(focus),
          let root = focusedWindow(processIdentifier: focus.processIdentifier) else {
      throw ComputerAccessibilityError.staleElement
    }
    var current = root
    for childIndex in locator.path {
      let values = children(current)
      guard childIndex >= 0, childIndex < values.count else { throw ComputerAccessibilityError.staleElement }
      current = values[childIndex]
    }
    let role = stringAttribute(current, kAXRoleAttribute as CFString) ?? "AXUnknown"
    let subrole = stringAttribute(current, kAXSubroleAttribute as CFString)
    let identifier = stringAttribute(current, kAXIdentifierAttribute as CFString)
    let title = firstText(current)
    guard role == locator.role, subrole == locator.subrole,
          (locator.identifier == nil || identifier == locator.identifier),
          (locator.identifier != nil || locator.title == nil || title == locator.title),
          framesMatch(elementFrame(current), locator.frame) else {
      throw ComputerAccessibilityError.staleElement
    }
    return current
  }

  private static func focusElement(_ element: AXUIElement) throws {
    var settable = DarwinBoolean(false)
    if AXUIElementIsAttributeSettable(element, kAXFocusedAttribute as CFString, &settable) == .success,
       settable.boolValue,
       AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success {
      return
    }
    guard actionNames(element).contains(kAXPressAction as String),
          AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else {
      throw ComputerAccessibilityError.unsupportedAction
    }
  }

  private static func focusedWindow(processIdentifier: pid_t) -> AXUIElement? {
    let application = AXUIElementCreateApplication(processIdentifier)
    var raw: AnyObject?
    guard AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute as CFString, &raw) == .success,
          let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
    return (raw as! AXUIElement)
  }

  private static func children(_ element: AXUIElement) -> [AXUIElement] {
    var raw: AnyObject?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &raw) == .success,
          let values = raw as? [AnyObject] else { return [] }
    return values.compactMap { value in
      CFGetTypeID(value) == AXUIElementGetTypeID() ? (value as! AXUIElement) : nil
    }
  }

  private static func actionNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success,
          let values = names as? [String] else { return [] }
    return values
  }

  private static func stringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String? {
    var raw: AnyObject?
    guard AXUIElementCopyAttributeValue(element, attribute, &raw) == .success, let raw else { return nil }
    if let value = raw as? String { return value }
    if let value = raw as? NSNumber { return value.stringValue }
    return nil
  }

  private static func firstText(_ element: AXUIElement) -> String? {
    for attribute in [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute] {
      if let value = bounded(stringAttribute(element, attribute as CFString), 500), !value.isEmpty { return value }
    }
    return nil
  }

  private static func elementFrame(_ element: AXUIElement) -> CGRect? {
    var rawPosition: AnyObject?
    var rawSize: AnyObject?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &rawPosition) == .success,
          AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &rawSize) == .success,
          let rawPosition, let rawSize,
          CFGetTypeID(rawPosition) == AXValueGetTypeID(), CFGetTypeID(rawSize) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(rawPosition as! AXValue, .cgPoint, &point),
          AXValueGetValue(rawSize as! AXValue, .cgSize, &size),
          [point.x, point.y, size.width, size.height].allSatisfy({ $0.isFinite }),
          size.width > 0, size.height > 0 else { return nil }
    return CGRect(origin: point, size: size)
  }

  private static func framesMatch(_ current: CGRect?, _ expected: CGRect?) -> Bool {
    if current == nil && expected == nil { return true }
    guard let current, let expected else { return false }
    return ComputerScreenshot.framesReferToSameWindow(current, expected, tolerance: 4)
  }

  private static func isSecure(role: String, subrole: String?) -> Bool {
    role.localizedCaseInsensitiveContains("secure")
      || (subrole?.localizedCaseInsensitiveContains("secure") ?? false)
  }

  static func bounded(_ value: String?, _ limit: Int) -> String? {
    guard let value else { return nil }
    let normalized = value.replacingOccurrences(of: "[\\p{C}\\r\\n\\t]+", with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else { return nil }
    guard normalized.utf8.count > limit else { return normalized }
    var result = ""
    var byteCount = 0
    for character in normalized {
      let bytes = String(character).utf8.count
      if byteCount + bytes > limit { break }
      result.append(character)
      byteCount += bytes
    }
    return result.isEmpty ? nil : result
  }

  static func uniqueTextRange(
    content: String,
    text: String,
    prefix: String?,
    suffix: String?
  ) throws -> NSRange {
    let source = content as NSString
    let needleLength = (text as NSString).length
    guard needleLength > 0 else { throw ComputerAccessibilityError.ambiguousText }
    var matches: [NSRange] = []
    var search = NSRange(location: 0, length: source.length)
    while search.length >= needleLength {
      let found = source.range(of: text, options: [], range: search)
      if found.location == NSNotFound { break }
      let prefixOK = prefix.map { value in
        let length = (value as NSString).length
        return found.location >= length
          && source.substring(with: NSRange(location: found.location - length, length: length)) == value
      } ?? true
      let suffixOK = suffix.map { value in
        let length = (value as NSString).length
        let start = found.location + found.length
        return start + length <= source.length
          && source.substring(with: NSRange(location: start, length: length)) == value
      } ?? true
      if prefixOK && suffixOK { matches.append(found) }
      if matches.count > 1 { throw ComputerAccessibilityError.ambiguousText }
      let firstCharacter = source.rangeOfComposedCharacterSequence(at: found.location)
      let next = firstCharacter.location + max(1, firstCharacter.length)
      search = NSRange(location: next, length: source.length - next)
    }
    guard matches.count == 1 else { throw ComputerAccessibilityError.ambiguousText }
    return matches[0]
  }

  private static func escaped(_ value: String) -> String {
    value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
  }

  private struct PasteboardSnapshot {
    let items: [NSPasteboardItem]
  }

  private static func snapshotPasteboard(_ pasteboard: NSPasteboard) throws -> PasteboardSnapshot {
    let items = pasteboard.pasteboardItems ?? []
    guard items.count <= 128,
          items.allSatisfy({ item in
            item.types.count <= 128 && item.types.allSatisfy { $0.rawValue.utf8.count <= 1_024 }
          }) else { throw ComputerAccessibilityError.clipboardFailed }
    // Keep the pasteboard items themselves. Reading every declared type here
    // can force unbounded or expensive lazy providers before we ever paste.
    return PasteboardSnapshot(items: items)
  }

  private static func restorePasteboard(
    _ pasteboard: NSPasteboard,
    saved: PasteboardSnapshot,
    expectedChangeCount: Int
  ) {
    // Never overwrite a clipboard change the user or another application made
    // while the synthetic paste was in flight.
    guard pasteboard.changeCount == expectedChangeCount else { return }
    pasteboard.clearContents()
    if !saved.items.isEmpty { _ = pasteboard.writeObjects(saved.items) }
  }
}

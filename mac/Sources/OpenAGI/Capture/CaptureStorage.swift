import Foundation
import SQLite3

// Local SQLite store for captured frames + activity. The OCR text and
// activity events get pushed to the daemon via Bridge for cross-machine
// recall; this local store is the source of truth for thumbnails and
// raw history (so we don't lose anything on a daemon restart).

final class CaptureStorage {
  static let shared = CaptureStorage()

  private var db: OpaquePointer?
  private let queue = DispatchQueue(label: "openagi.capture.storage")

  private init() {
    let dbPath = CaptureSettings.captureDir.appendingPathComponent("index.db").path
    if sqlite3_open(dbPath, &db) != SQLITE_OK {
      NSLog("OpenAGI: failed to open capture db at \(dbPath)")
      return
    }
    let schema = """
      CREATE TABLE IF NOT EXISTS frames (
        id INTEGER PRIMARY KEY,
        frame_uid TEXT UNIQUE,
        captured_at TEXT NOT NULL,
        app TEXT,
        window TEXT,
        thumbnail_path TEXT,
        confidence REAL,
        pushed INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS frames_at ON frames(captured_at);
      CREATE INDEX IF NOT EXISTS frames_pushed ON frames(pushed);

      CREATE TABLE IF NOT EXISTS activity (
        id INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        app TEXT,
        window TEXT,
        event TEXT,
        pushed INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS activity_at ON activity(at);
      CREATE INDEX IF NOT EXISTS activity_pushed ON activity(pushed);

      CREATE TABLE IF NOT EXISTS texts (
        frame_uid TEXT PRIMARY KEY,
        text TEXT,
        confidence REAL
      );
    """
    sqlite3_exec(db, schema, nil, nil, nil)
  }

  func recordActivity(at: Date, app: String?, window: String?, event: String) {
    queue.sync {
      let sql = "INSERT INTO activity (at, app, window, event) VALUES (?, ?, ?, ?)"
      var stmt: OpaquePointer?
      defer { sqlite3_finalize(stmt) }
      guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
      sqlite3_bind_text(stmt, 1, ISO8601DateFormatter().string(from: at), -1, SQLITE_TRANSIENT)
      bindOptionalText(stmt, 2, app)
      bindOptionalText(stmt, 3, window)
      sqlite3_bind_text(stmt, 4, event, -1, SQLITE_TRANSIENT)
      sqlite3_step(stmt)
    }
  }

  func recordFrame(uid: String, capturedAt: Date, app: String?, window: String?, thumbnailPath: String?, ocrText: String, confidence: Double) {
    queue.sync {
      let frameSql = "INSERT OR IGNORE INTO frames (frame_uid, captured_at, app, window, thumbnail_path, confidence) VALUES (?, ?, ?, ?, ?, ?)"
      var stmt: OpaquePointer?
      if sqlite3_prepare_v2(db, frameSql, -1, &stmt, nil) == SQLITE_OK {
        sqlite3_bind_text(stmt, 1, uid, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 2, ISO8601DateFormatter().string(from: capturedAt), -1, SQLITE_TRANSIENT)
        bindOptionalText(stmt, 3, app)
        bindOptionalText(stmt, 4, window)
        bindOptionalText(stmt, 5, thumbnailPath)
        sqlite3_bind_double(stmt, 6, confidence)
        sqlite3_step(stmt)
      }
      sqlite3_finalize(stmt)

      let textSql = "INSERT OR REPLACE INTO texts (frame_uid, text, confidence) VALUES (?, ?, ?)"
      var ts: OpaquePointer?
      if sqlite3_prepare_v2(db, textSql, -1, &ts, nil) == SQLITE_OK {
        sqlite3_bind_text(ts, 1, uid, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(ts, 2, ocrText, -1, SQLITE_TRANSIENT)
        sqlite3_bind_double(ts, 3, confidence)
        sqlite3_step(ts)
      }
      sqlite3_finalize(ts)
    }
  }

  /// Pull a batch of unpushed observations to send to the daemon.
  func unpushedBatch(limit: Int = 100) -> [[String: Any]] {
    queue.sync {
      var out: [[String: Any]] = []

      // Activity
      let aSql = "SELECT id, at, app, window, event FROM activity WHERE pushed = 0 ORDER BY id LIMIT ?"
      var astmt: OpaquePointer?
      if sqlite3_prepare_v2(db, aSql, -1, &astmt, nil) == SQLITE_OK {
        sqlite3_bind_int(astmt, 1, Int32(limit))
        while sqlite3_step(astmt) == SQLITE_ROW {
          let id = sqlite3_column_int64(astmt, 0)
          out.append([
            "_id": id, "_table": "activity",
            "kind": "activity",
            "at": columnText(astmt, 1) ?? "",
            "app": columnText(astmt, 2) as Any,
            "window": columnText(astmt, 3) as Any,
            "event": columnText(astmt, 4) as Any
          ])
        }
      }
      sqlite3_finalize(astmt)

      // Frames + their text
      let fSql = """
        SELECT f.id, f.frame_uid, f.captured_at, f.app, f.window, f.confidence, t.text
        FROM frames f LEFT JOIN texts t ON t.frame_uid = f.frame_uid
        WHERE f.pushed = 0 ORDER BY f.id LIMIT ?
      """
      var fstmt: OpaquePointer?
      if sqlite3_prepare_v2(db, fSql, -1, &fstmt, nil) == SQLITE_OK {
        sqlite3_bind_int(fstmt, 1, Int32(limit))
        while sqlite3_step(fstmt) == SQLITE_ROW {
          let id = sqlite3_column_int64(fstmt, 0)
          out.append([
            "_id": id, "_table": "frames",
            "kind": "frame",
            "frameId": columnText(fstmt, 1) ?? "",
            "at": columnText(fstmt, 2) ?? "",
            "app": columnText(fstmt, 3) as Any,
            "window": columnText(fstmt, 4) as Any,
            "confidence": sqlite3_column_double(fstmt, 5),
            "ocrText": columnText(fstmt, 6) ?? ""
          ])
        }
      }
      sqlite3_finalize(fstmt)

      return out
    }
  }

  func markPushed(activityIds: [Int64], frameIds: [Int64]) {
    queue.sync {
      if !activityIds.isEmpty {
        let sql = "UPDATE activity SET pushed = 1 WHERE id IN (\(activityIds.map { String($0) }.joined(separator: ",")))"
        sqlite3_exec(db, sql, nil, nil, nil)
      }
      if !frameIds.isEmpty {
        let sql = "UPDATE frames SET pushed = 1 WHERE id IN (\(frameIds.map { String($0) }.joined(separator: ",")))"
        sqlite3_exec(db, sql, nil, nil, nil)
      }
    }
  }

  func stats() -> (frames: Int, activity: Int, diskBytes: Int) {
    queue.sync {
      let f = scalarInt("SELECT COUNT(*) FROM frames")
      let a = scalarInt("SELECT COUNT(*) FROM activity")
      let bytes = directorySize(at: CaptureSettings.captureDir)
      return (f, a, bytes)
    }
  }

  func prune(framesOlderThan: Date, textOlderThan: Date) {
    queue.sync {
      let fIso = ISO8601DateFormatter().string(from: framesOlderThan)
      let tIso = ISO8601DateFormatter().string(from: textOlderThan)
      // Find thumbnails to unlink
      var paths: [String] = []
      let qsql = "SELECT thumbnail_path FROM frames WHERE captured_at < ? AND thumbnail_path IS NOT NULL"
      var qs: OpaquePointer?
      if sqlite3_prepare_v2(db, qsql, -1, &qs, nil) == SQLITE_OK {
        sqlite3_bind_text(qs, 1, fIso, -1, SQLITE_TRANSIENT)
        while sqlite3_step(qs) == SQLITE_ROW { if let p = columnText(qs, 0) { paths.append(p) } }
      }
      sqlite3_finalize(qs)
      for p in paths { try? FileManager.default.removeItem(atPath: p) }

      let delF = "DELETE FROM frames WHERE captured_at < ?"
      var s1: OpaquePointer?
      if sqlite3_prepare_v2(db, delF, -1, &s1, nil) == SQLITE_OK {
        sqlite3_bind_text(s1, 1, fIso, -1, SQLITE_TRANSIENT); sqlite3_step(s1)
      }
      sqlite3_finalize(s1)

      let delA = "DELETE FROM activity WHERE at < ?"
      var s2: OpaquePointer?
      if sqlite3_prepare_v2(db, delA, -1, &s2, nil) == SQLITE_OK {
        sqlite3_bind_text(s2, 1, tIso, -1, SQLITE_TRANSIENT); sqlite3_step(s2)
      }
      sqlite3_finalize(s2)

      let delT = "DELETE FROM texts WHERE frame_uid NOT IN (SELECT frame_uid FROM frames)"
      sqlite3_exec(db, delT, nil, nil, nil)
    }
  }

  func wipeAll() {
    queue.sync {
      sqlite3_exec(db, "DELETE FROM frames; DELETE FROM activity; DELETE FROM texts;", nil, nil, nil)
      let thumbsDir = CaptureSettings.captureDir.appendingPathComponent("thumbnails")
      try? FileManager.default.removeItem(at: thumbsDir)
      try? FileManager.default.createDirectory(at: thumbsDir, withIntermediateDirectories: true)
    }
  }

  private func scalarInt(_ sql: String) -> Int {
    var stmt: OpaquePointer?
    defer { sqlite3_finalize(stmt) }
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return 0 }
    if sqlite3_step(stmt) == SQLITE_ROW { return Int(sqlite3_column_int64(stmt, 0)) }
    return 0
  }
}

// MARK: — sqlite helpers

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

private func bindOptionalText(_ stmt: OpaquePointer?, _ idx: Int32, _ value: String?) {
  if let v = value {
    sqlite3_bind_text(stmt, idx, v, -1, SQLITE_TRANSIENT)
  } else {
    sqlite3_bind_null(stmt, idx)
  }
}

private func columnText(_ stmt: OpaquePointer?, _ idx: Int32) -> String? {
  guard let cstr = sqlite3_column_text(stmt, idx) else { return nil }
  return String(cString: cstr)
}

private func directorySize(at url: URL) -> Int {
  let fm = FileManager.default
  guard let enumerator = fm.enumerator(at: url, includingPropertiesForKeys: [.totalFileAllocatedSizeKey], options: [], errorHandler: nil) else { return 0 }
  var total = 0
  for case let file as URL in enumerator {
    let values = try? file.resourceValues(forKeys: [.totalFileAllocatedSizeKey])
    total += values?.totalFileAllocatedSize ?? 0
  }
  return total
}

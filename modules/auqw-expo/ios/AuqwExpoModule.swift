import ExpoModulesCore
import OSLog

private let logger = Logger(subsystem: "com.vehicoule.auqw", category: "AuqwExpo")
private let eventOutcome = "onResolveOutcome"
private let eventRequestOutcome = "onRequestOutcome"

struct HostConfigInput: Record {
  @Field var fuelPerEntry: Double = 0
  @Field var fuelTotal: Double = 0
  @Field var potProviderUrl: String? = nil
  @Field var statePath: String? = nil
  // iOS exposes the host surface only — the player surface is
  // Android-first, so streamPath stays unset (seam unavailable)
  // unless a caller deliberately overrides it.
  @Field var streamPath: String? = nil
}

/// Relays the UniFFI callback into the Expo event channel. The outcome
/// carries no URL — `resource.url` is forwarded only inside the event
/// payload and is never logged.
final class OutcomeRelay: ResolveListener, @unchecked Sendable {
  private let emit: (String, ResolveOutcome) -> Void

  init(emit: @escaping (String, ResolveOutcome) -> Void) {
    self.emit = emit
  }

  func onOutcome(requestId: String, outcome: ResolveOutcome) {
    switch outcome {
    case let .resolved(resource, attempt):
      logger.info(
        "resolve \(requestId, privacy: .public) resolved client=\(resource.client, privacy: .public) mime=\(resource.mime, privacy: .public) steps=\(attempt.steps) elapsed=\(attempt.elapsedMs)ms"
      )
    case let .failed(kind, message, _):
      logger.info(
        "resolve \(requestId, privacy: .public) failed kind=\(kind, privacy: .public) message=\(message, privacy: .public)"
      )
    }
    emit(requestId, outcome)
  }
}

/// Relays generic-request outcomes into the `onRequestOutcome` event.
final class RequestRelay: RequestListener, @unchecked Sendable {
  private let emit: (String, RequestOutcome) -> Void

  init(emit: @escaping (String, RequestOutcome) -> Void) {
    self.emit = emit
  }

  func onOutcome(requestId: String, outcome: RequestOutcome) {
    switch outcome {
    case let .succeeded(_, attempt):
      logger.info(
        "request \(requestId, privacy: .public) succeeded steps=\(attempt.steps) elapsed=\(attempt.elapsedMs)ms"
      )
    case let .failed(kind, message, _):
      logger.info(
        "request \(requestId, privacy: .public) failed kind=\(kind, privacy: .public) message=\(message, privacy: .public)"
      )
    }
    emit(requestId, outcome)
  }
}

/// Host surface only. The player surface (prepare/play/…/phaseMarks)
/// is Android-first: iOS injects through `AVAssetResourceLoaderDelegate`
/// post-release, and `prefer: mp4` is required there — see
/// docs/specs/playback.md ("Streaming seam").
public class AuqwExpoModule: Module {
  private var host: PluginHost?

  public func definition() -> ModuleDefinition {
    Name("AuqwExpo")

    Events(eventOutcome, eventRequestOutcome)

    AsyncFunction("createHost") { (config: HostConfigInput) in
      let h = try PluginHost(
        config: HostConfig(
          fuelPerEntry: Self.clampedU64(config.fuelPerEntry),
          fuelTotal: Self.clampedU64(config.fuelTotal),
          potProviderUrl: config.potProviderUrl,
          statePath: try config.statePath ?? Self.statePath(),
          streamPath: config.streamPath
        )
      )
      self.host = h
      logger.info("host created")
    }

    AsyncFunction("loadPlugin") { (wasmBase64: String, manifestJson: String) -> String in
      let h = try self.requireHost()
      guard let wasm = Data(base64Encoded: wasmBase64) else {
        throw Exception(name: "ERR_BAD_ARGS", description: "wasmBase64 is not valid base64")
      }
      return try h.loadPlugin(wasm: wasm, manifestJson: manifestJson)
    }

    AsyncFunction("startResolve") { (pluginId: String, sourceRef: String) -> String in
      let h = try self.requireHost()
      let relay = OutcomeRelay { requestId, outcome in
        self.sendEvent(eventOutcome, [
          "requestId": requestId,
          "outcome": Self.outcomeDict(outcome),
        ])
      }
      return try h.startResolve(pluginId: pluginId, sourceRef: sourceRef, listener: relay)
    }

    AsyncFunction("startRequest") { (pluginId: String, capability: String, payloadJson: String) -> String in
      let h = try self.requireHost()
      let relay = RequestRelay { requestId, outcome in
        self.sendEvent(eventRequestOutcome, [
          "requestId": requestId,
          "outcome": Self.requestOutcomeDict(outcome),
        ])
      }
      return try h.startRequest(pluginId: pluginId, capability: capability, payloadJson: payloadJson, listener: relay)
    }

    Function("cancel") { (requestId: String) in
      self.host?.cancel(requestId: requestId)
      logger.info("cancel requested: \(requestId, privacy: .public)")
    }

    AsyncFunction("runSpin") { (wasmBase64: String, manifestJson: String) -> [String: Any] in
      let h = try self.requireHost()
      guard let wasm = Data(base64Encoded: wasmBase64) else {
        throw Exception(name: "ERR_BAD_ARGS", description: "wasmBase64 is not valid base64")
      }
      let report = try h.runSpin(wasm: wasm, manifestJson: manifestJson)
      logger.info(
        "spin: kind=\(report.kind, privacy: .public) elapsed=\(report.elapsedMs)ms fuel=\(report.fuelUsed)"
      )
      return [
        "elapsedMs": Double(report.elapsedMs),
        "fuelUsed": Double(report.fuelUsed),
        "kind": report.kind,
      ]
    }
  }

  private func requireHost() throws -> PluginHost {
    guard let host else {
      throw Exception(name: "ERR_NO_HOST", description: "createHost first")
    }
    return host
  }

  /// JS numbers arrive as Double; `UInt64(Double)` traps on negative,
  /// fractional-adjacent overflow, or NaN input. Clamp instead of crashing
  /// the host boundary.
  private static func clampedU64(_ value: Double) -> UInt64 {
    UInt64(exactly: value.rounded(.towardZero)) ?? (value > 0 ? UInt64.max : 0)
  }

  /// The KV store lives under Application Support so plugin state
  /// survives launches. A missing/blocked directory is a typed error —
  /// silently falling back to volatile memory would lose state.
  private static func statePath() throws -> String {
    let fm = FileManager.default
    guard let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
      throw Exception(name: "ERR_RUNTIME", description: "no Application Support directory")
    }
    let dir = support.appendingPathComponent("Auqw", isDirectory: true)
    do {
      try fm.createDirectory(at: dir, withIntermediateDirectories: true)
    } catch {
      throw Exception(name: "ERR_RUNTIME", description: "state path: \(error.localizedDescription)")
    }
    return dir.appendingPathComponent("plugin-kv.json").path
  }

  private static func attemptDict(_ a: AttemptSummary) -> [String: Any] {
    [
      "requestId": a.requestId,
      "steps": Double(a.steps),
      "httpCalls": Double(a.httpCalls),
      "bytes": Double(a.bytes),
      "fuelUsed": Double(a.fuelUsed),
      "elapsedMs": Double(a.elapsedMs),
      "httpTrace": a.httpTrace.map { e in
        var d: [String: Any] = [
          "method": e.method,
          "url": e.url,
          "bytes": Double(e.bytes),
          "elapsedMs": Double(e.elapsedMs),
        ]
        if let s = e.status { d["status"] = Double(s) }
        return d
      },
      "guestLog": a.guestLog.map { e in
        [
          "level": e.level,
          "message": e.message,
        ]
      },
    ]
  }

  private static func requestOutcomeDict(_ outcome: RequestOutcome) -> [String: Any] {
    switch outcome {
    case let .succeeded(resultJson, attempt):
      return [
        "type": "succeeded",
        "resultJson": resultJson,
        "attempt": attemptDict(attempt),
      ]
    case let .failed(kind, message, attempt):
      return [
        "type": "failed",
        "kind": kind,
        "message": message,
        "attempt": attemptDict(attempt),
      ]
    }
  }

  private static func outcomeDict(_ outcome: ResolveOutcome) -> [String: Any] {
    switch outcome {
    case let .resolved(resource, attempt):
      var r: [String: Any] = [
        "url": resource.url,
        "mime": resource.mime,
        "client": resource.client,
      ]
      if let v = resource.bitrateKbps { r["bitrateKbps"] = Double(v) }
      if let v = resource.expiresAtMs { r["expiresAtMs"] = Double(v) }
      if let v = resource.contentLength { r["contentLength"] = Double(v) }
      if let v = resource.itag { r["itag"] = Double(v) }
      return [
        "type": "resolved",
        "resource": r,
        "attempt": attemptDict(attempt),
      ]
    case let .failed(kind, message, attempt):
      return [
        "type": "failed",
        "kind": kind,
        "message": message,
        "attempt": attemptDict(attempt),
      ]
    }
  }
}

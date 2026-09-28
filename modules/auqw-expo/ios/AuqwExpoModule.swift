import ExpoModulesCore
import OSLog

private let logger = Logger(subsystem: "com.vehicoule.auqw", category: "AuqwExpo")
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
  // Container preference order for playback.resolve — iOS is
  // mp4-required (AVPlayer has no WebM/Opus); nil = guest default.
  @Field var prefer: [String]? = nil
  // Initial OAuth access token for Authorization: Bearer on InnerTube
  // calls — the session-trust header. nil = anonymous; refresh via
  // setAuthToken. Never logged.
  @Field var authToken: String? = nil
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

    Events(eventRequestOutcome)

    AsyncFunction("createHost") { (config: HostConfigInput) in
      let h = try PluginHost(
        config: HostConfig(
          fuelPerEntry: Self.clampedU64(config.fuelPerEntry),
          fuelTotal: Self.clampedU64(config.fuelTotal),
          potProviderUrl: config.potProviderUrl,
          statePath: try config.statePath ?? Self.statePath(),
          streamPath: config.streamPath,
          prefer: config.prefer,
          authToken: config.authToken
        )
      )
      self.host = h
      logger.info("host created")
    }

    Function("setAuthToken") { (token: String?) in
      let h = try self.requireHost()
      h.setAuthToken(token: token)
    }

    // Live PO-token provider update — resolves read the host's slot
    // at invocation spawn, so a pairing or unpairing landing after
    // createHost applies without a host recreate. nil restores the
    // anonymous resolve ladder.
    Function("setPotProvider") { (url: String?) in
      let h = try self.requireHost()
      h.setPotProvider(url: url)
    }

    AsyncFunction("loadPlugin") { (wasmBase64: String, manifestJson: String) -> String in
      let h = try self.requireHost()
      guard let wasm = Data(base64Encoded: wasmBase64) else {
        throw Exception(name: "ERR_BAD_ARGS", description: "wasmBase64 is not valid base64")
      }
      return try h.loadPlugin(wasm: wasm, manifestJson: manifestJson)
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

}

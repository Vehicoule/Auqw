import ExpoModulesCore
import OSLog

private let logger = Logger(subsystem: "com.vehicoule.auqw", category: "PluginHostExpo")
private let eventOutcome = "onResolveOutcome"

struct HostConfigInput: Record {
  @Field var fuelPerEntry: Double = 0
  @Field var fuelTotal: Double = 0
  @Field var potProviderUrl: String? = nil
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

public class PluginHostExpoModule: Module {
  private var host: PluginHost?

  public func definition() -> ModuleDefinition {
    Name("PluginHostExpo")

    Events(eventOutcome)

    AsyncFunction("createHost") { (config: HostConfigInput) in
      let h = try PluginHost(
        config: HostConfig(
          fuelPerEntry: UInt64(config.fuelPerEntry),
          fuelTotal: UInt64(config.fuelTotal),
          potProviderUrl: config.potProviderUrl
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

  private static func attemptDict(_ a: AttemptSummary) -> [String: Any] {
    [
      "requestId": a.requestId,
      "steps": Double(a.steps),
      "httpCalls": Double(a.httpCalls),
      "bytes": Double(a.bytes),
      "fuelUsed": Double(a.fuelUsed),
      "elapsedMs": Double(a.elapsedMs),
    ]
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

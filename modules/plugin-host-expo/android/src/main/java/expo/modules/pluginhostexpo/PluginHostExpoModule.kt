package expo.modules.pluginhostexpo

import android.os.Bundle
import android.util.Base64
import android.util.Log
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import uniffi.auqw_mobile_bindings.AttemptSummary
import uniffi.auqw_mobile_bindings.HostConfig
import uniffi.auqw_mobile_bindings.HostException
import uniffi.auqw_mobile_bindings.PluginHost
import uniffi.auqw_mobile_bindings.ResolveListener
import uniffi.auqw_mobile_bindings.ResolveOutcome
import uniffi.auqw_mobile_bindings.SpinReport

private const val TAG = "PluginHostExpo"
private const val EVENT_OUTCOME = "onResolveOutcome"

class HostConfigInput : Record {
  @Field
  var fuelPerEntry: Double = 0.0

  @Field
  var fuelTotal: Double = 0.0
}

class PluginHostExpoModule : Module() {
  private var host: PluginHost? = null

  override fun definition() = ModuleDefinition {
    Name("PluginHostExpo")

    Events(EVENT_OUTCOME)

    AsyncFunction("createHost") { config: HostConfigInput ->
      val h = try {
        PluginHost(
          HostConfig(
            fuelPerEntry = config.fuelPerEntry.toULong(),
            fuelTotal = config.fuelTotal.toULong()
          )
        )
      } catch (e: HostException) {
        throw coded(e)
      }
      host = h
      Log.i(TAG, "host created")
      null
    }

    AsyncFunction("loadPlugin") { wasmBase64: String, manifestJson: String ->
      val h = host ?: throw CodedException("ERR_NO_HOST", "createHost first", null)
      val wasm = Base64.decode(wasmBase64, Base64.DEFAULT)
      try {
        h.loadPlugin(wasm, manifestJson)
      } catch (e: HostException) {
        throw coded(e)
      }
    }

    AsyncFunction("startResolve") { pluginId: String, sourceRef: String ->
      val h = host ?: throw CodedException("ERR_NO_HOST", "createHost first", null)
      val listener = object : ResolveListener {
        override fun onOutcome(requestId: String, outcome: ResolveOutcome) {
          when (outcome) {
            is ResolveOutcome.Resolved -> {
              Log.i(
                TAG,
                "resolve $requestId resolved client=${outcome.resource.client} " +
                  "mime=${outcome.resource.mime} steps=${outcome.attempt.steps} " +
                  "elapsed=${outcome.attempt.elapsedMs}ms"
              )
            }
            is ResolveOutcome.Failed -> {
              Log.i(
                TAG,
                "resolve $requestId failed kind=${outcome.kind} " +
                  "message=${outcome.message}"
              )
            }
          }
          sendEvent(
            EVENT_OUTCOME,
            Bundle().apply {
              putString("requestId", requestId)
              putBundle("outcome", outcomeBundle(outcome))
            }
          )
        }
      }
      try {
        h.startResolve(pluginId, sourceRef, listener)
      } catch (e: HostException) {
        throw coded(e)
      }
    }

    Function("cancel") { requestId: String ->
      host?.cancel(requestId)
      Log.i(TAG, "cancel requested: $requestId")
      null
    }

    AsyncFunction("runSpin") { wasmBase64: String, manifestJson: String ->
      val h = host ?: throw CodedException("ERR_NO_HOST", "createHost first", null)
      val wasm = Base64.decode(wasmBase64, Base64.DEFAULT)
      val report = try {
        h.runSpin(wasm, manifestJson)
      } catch (e: HostException) {
        throw coded(e)
      }
      Log.i(
        TAG,
        "spin: kind=${report.kind} elapsed=${report.elapsedMs}ms " +
          "fuel=${report.fuelUsed}"
      )
      reportBundle(report)
    }
  }

  private fun attemptBundle(a: AttemptSummary) = Bundle().apply {
    putString("requestId", a.requestId)
    putDouble("steps", a.steps.toDouble())
    putDouble("httpCalls", a.httpCalls.toDouble())
    putDouble("bytes", a.bytes.toDouble())
    putDouble("fuelUsed", a.fuelUsed.toDouble())
    putDouble("elapsedMs", a.elapsedMs.toDouble())
  }

  private fun outcomeBundle(outcome: ResolveOutcome): Bundle = when (outcome) {
    is ResolveOutcome.Resolved -> Bundle().apply {
      putString("type", "resolved")
      putBundle(
        "resource",
        Bundle().apply {
          putString("url", outcome.resource.url)
          putString("mime", outcome.resource.mime)
          outcome.resource.bitrateKbps?.let { putDouble("bitrateKbps", it.toDouble()) }
          outcome.resource.expiresAtMs?.let { putDouble("expiresAtMs", it.toDouble()) }
          putString("client", outcome.resource.client)
          outcome.resource.contentLength?.let { putDouble("contentLength", it.toDouble()) }
        }
      )
      putBundle("attempt", attemptBundle(outcome.attempt))
    }
    is ResolveOutcome.Failed -> Bundle().apply {
      putString("type", "failed")
      putString("kind", outcome.kind)
      putString("message", outcome.message)
      putBundle("attempt", attemptBundle(outcome.attempt))
    }
  }

  private fun reportBundle(r: SpinReport) = Bundle().apply {
    putDouble("elapsedMs", r.elapsedMs.toDouble())
    putDouble("fuelUsed", r.fuelUsed.toDouble())
    putString("kind", r.kind)
  }

  private fun coded(e: HostException): CodedException = when (e) {
    is HostException.Load -> CodedException("ERR_LOAD", e.message, e)
    is HostException.UnknownPlugin -> CodedException("ERR_UNKNOWN_PLUGIN", e.message, e)
    is HostException.Runtime -> CodedException("ERR_RUNTIME", e.message, e)
    else -> CodedException("ERR_HOST", e.message, e)
  }
}

require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'AuqwExpo'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = 'auqw'
  s.homepage       = 'https://dev.invalid'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Rust staticlib + UniFFI FFI module, built by
  # tooling/build-ios-bindings.sh. The xcframework carries the
  # auqw_mobile_bindingsFFI clang module (module.modulemap) that the
  # generated auqw_mobile_bindings.swift imports.
  s.vendored_frameworks = 'AuqwMobileBindingsFFI.xcframework'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '*.swift'
end

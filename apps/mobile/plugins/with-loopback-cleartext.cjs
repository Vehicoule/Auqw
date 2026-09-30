// The stream seam serves audio to the in-process player over plain
// HTTP on loopback (crates/auqw-stream/src/server.rs — serve_url
// emits `http://127.0.0.1:{port}/s/{token}`). With targetSdk ≥ 28
// `usesCleartextTraffic` defaults to false, and Android's cleartext
// policy has no IP-literal/loopback exemption — the debug manifests
// set the flag but the RELEASE manifest inherited the block, so every
// pump attach was denied after a successful resolve (the transient
// toast on release builds). Scoped to loopback literals only: the
// rest of the app keeps the platform default.
const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const NETWORK_SECURITY_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">127.0.0.1</domain>
    <domain includeSubdomains="false">localhost</domain>
  </domain-config>
</network-security-config>
`;

const withLoopbackCleartext = (config) => {
  config = withDangerousMod(config, [
    'android',
    async (cfg) => {
      const dir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app/src/main/res/xml',
      );
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(
        path.join(dir, 'network_security_config.xml'),
        NETWORK_SECURITY_CONFIG,
      );
      return cfg;
    },
  ]);
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (app) {
      app.$['android:networkSecurityConfig'] = '@xml/network_security_config';
    }
    return cfg;
  });
};

module.exports = withLoopbackCleartext;

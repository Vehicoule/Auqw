// The stream seam serves audio to the in-process player over plain
// HTTP on loopback (crates/auqw-stream/src/server.rs — serve_url
// emits `http://127.0.0.1:{port}/s/{token}`). With targetSdk ≥ 28
// `usesCleartextTraffic` defaults to false, and Android's cleartext
// policy has no IP-literal/loopback exemption — the debug manifests
// set the flag but the RELEASE manifest inherited the block, so every
// pump attach was denied after a successful resolve (the transient
// toast on release builds).
//
// The config lands in src/release/, not src/main/: a
// networkSecurityConfig on the shared manifest would REPLACE the
// debug manifest's cleartext flag for dev builds too, and the
// loopback-only allowlist would then cut debug builds off from Metro
// (the emulator reaches it at http://10.0.2.2:8081, a physical device
// at its LAN address). The release-only manifest overlay keeps debug
// untouched; the xml sits in main res so the reference resolves.
const { withDangerousMod } = require('expo/config-plugins');
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

const RELEASE_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:networkSecurityConfig="@xml/network_security_config"/>
</manifest>
`;

const withLoopbackCleartext = (config) =>
  withDangerousMod(config, [
    'android',
    async (cfg) => {
      const res = path.join(
        cfg.modRequest.platformProjectRoot,
        'app/src/main/res/xml',
      );
      await fs.promises.mkdir(res, { recursive: true });
      await fs.promises.writeFile(
        path.join(res, 'network_security_config.xml'),
        NETWORK_SECURITY_CONFIG,
      );
      const release = path.join(
        cfg.modRequest.platformProjectRoot,
        'app/src/release',
      );
      await fs.promises.mkdir(release, { recursive: true });
      await fs.promises.writeFile(
        path.join(release, 'AndroidManifest.xml'),
        RELEASE_MANIFEST,
      );
      return cfg;
    },
  ]);

module.exports = withLoopbackCleartext;

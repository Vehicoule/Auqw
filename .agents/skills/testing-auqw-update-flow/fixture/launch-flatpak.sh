#!/bin/sh
# Simulated flatpak run: FLATPAK_ID set → capability 'open'.
exec env \
  DISPLAY=:0 \
  AUQW_NODE_BINDINGS=/home/ubuntu/repos/Auqw/target/debug/libauqw_node_bindings.so \
  AUQW_PLUGIN_DIR=/home/ubuntu/repos/Auqw/apps/desktop/plugins \
  FLATPAK_ID=com.vehicoule.auqw \
  AUQW_UPDATE_RELEASES_URL=https://127.0.0.1:4477/releases \
  /home/ubuntu/repos/Auqw/node_modules/electron/dist/electron \
  /home/ubuntu/repos/Auqw/apps/desktop \
  --no-sandbox --disable-gpu --enable-logging --ignore-certificate-errors

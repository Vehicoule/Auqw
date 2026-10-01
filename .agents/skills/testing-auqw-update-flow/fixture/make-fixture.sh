#!/bin/sh
# Regenerates the pieces of /tmp/auqw-sim that aren't worth committing:
# the self-signed cert pair and the padded marker artifacts.
# Usage: ./make-fixture.sh [fixture dir, default /tmp/auqw-sim] [pad bytes, default 4080000]
set -eu
DIR="${1:-/tmp/auqw-sim}"
PAD="${2:-4080000}"
mkdir -p "$DIR/appimage"

# Self-signed cert for 127.0.0.1 (CN + SAN) — the feed requires HTTPS and
# electron is launched with --ignore-certificate-errors to accept it.
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$DIR/key.pem" -out "$DIR/cert.pem" -days 3650 \
  -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1"
chmod 600 "$DIR/key.pem"

# Marker artifact: the restart-handoff proof. Logs NEW-APPIMAGE-EXEC then
# execs electron with the relaunch argv. Padded with '#' comment lines to
# $PAD bytes so FEED_BPS=250000 yields a ~16s cancel-friendly download.
# (feed.mjs sha256s the file at serve time, so padding is optional.)
ART="$DIR/appimage/auqw-9.9.9-linux-x86_64.AppImage"
{
  echo '#!/bin/sh'
  echo "echo \"NEW-APPIMAGE-EXEC \$(date -Is) \$@\" >> $DIR/ran.log"
  echo 'exec /home/ubuntu/repos/Auqw/node_modules/electron/dist/electron "$@"'
} > "$ART"
while [ "$(wc -c < "$ART")" -lt "$PAD" ]; do echo '#'; done >> "$ART"
chmod +x "$ART"

# Old-image stand-in at the $APPIMAGE path — apply renames the .new over it.
cp "$ART" "$DIR/appimage/Auqw-x86_64.AppImage"
chmod +x "$DIR/appimage/Auqw-x86_64.AppImage"

echo "fixture ready at $DIR — start the feed:"
echo "  setsid nohup env FEED_BPS=250000 node $DIR/feed.mjs >> $DIR/feed.log 2>&1 &"

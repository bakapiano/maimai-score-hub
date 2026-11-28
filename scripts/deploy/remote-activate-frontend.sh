#!/usr/bin/env bash
set -euo pipefail

WEB_ROOT="${1:?WEB_ROOT required}"
ARCHIVE="${2:?ARCHIVE required}"
RELEASE="${3:?RELEASE required}"

RELEASE_DIR="$WEB_ROOT/frontend-releases/$RELEASE"
INCOMING="$WEB_ROOT/frontend-releases/.incoming-$RELEASE"

test -n "$WEB_ROOT"
test -f "$ARCHIVE"
install -d -m 755 "$WEB_ROOT/frontend-releases"
rm -rf -- "$INCOMING"
install -d -m 755 "$INCOMING"
tar -xzf "$ARCHIVE" -C "$INCOMING"
test -s "$INCOMING/index.html"

# Keep several generations of content-hashed chunks reachable so
# WebViews that were already open during the atomic switch can
# finish lazy imports from their original main bundle.
install -d -m 755 "$INCOMING/assets"
find "$WEB_ROOT/frontend-releases" \
  -mindepth 1 -maxdepth 1 -type d \
  ! -name '.incoming-*' -printf '%T@ %p\n' \
  | sort -rn \
  | head -n 5 \
  | cut -d' ' -f2- \
  | while IFS= read -r PREVIOUS_DIR; do
      if [ -d "$PREVIOUS_DIR/assets" ]; then
        for PREVIOUS_ASSET in "$PREVIOUS_DIR"/assets/*; do
          [ -f "$PREVIOUS_ASSET" ] || continue
          TARGET_ASSET="$INCOMING/assets/$(basename "$PREVIOUS_ASSET")"
          if [ ! -e "$TARGET_ASSET" ]; then
            cp -a -- "$PREVIOUS_ASSET" "$TARGET_ASSET"
          fi
        done
      fi
    done
chmod -R a+rX "$INCOMING"

if [ -d "$RELEASE_DIR" ]; then
  rm -rf -- "$RELEASE_DIR"
fi
mv "$INCOMING" "$RELEASE_DIR"

test -s "$RELEASE_DIR/index.html"
test -s "$RELEASE_DIR/.well-known/assetlinks.json"
rm -f -- "$WEB_ROOT/frontend-current.next"
ln -s "frontend-releases/$RELEASE" "$WEB_ROOT/frontend-current.next"
mv -Tf "$WEB_ROOT/frontend-current.next" "$WEB_ROOT/frontend-current"
printf '%s\n' "$RELEASE" > "$WEB_ROOT/.frontend-revision"
rm -f -- "$ARCHIVE"

nginx -t
curl --resolve maiscorehub.bakapiano.com:443:127.0.0.1 \
  -fsS https://maiscorehub.bakapiano.com/ >/dev/null
curl --resolve maimai.bakapiano.com:443:127.0.0.1 \
  -fsS https://maimai.bakapiano.com/ >/dev/null
curl --resolve maiscorehub.bakapiano.com:443:127.0.0.1 \
  -fsSI https://maiscorehub.bakapiano.com/.well-known/assetlinks.json \
  | grep -qi '^content-type: application/json'
curl --resolve maiscorehub.bakapiano.com:443:127.0.0.1 \
  -fsS https://maiscorehub.bakapiano.com/.well-known/assetlinks.json \
  | grep -q 'com.bakapiano.maiscorehub.android.beta'
echo "Frontend static release activated: $RELEASE"

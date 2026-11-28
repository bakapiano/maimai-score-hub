#!/usr/bin/env bash
set -euo pipefail

WEB_ROOT="${1:?WEB_ROOT required}"
ARCHIVE="${2:?ARCHIVE required}"
RELEASE="${3:?RELEASE required}"

RELEASE_DIR="$WEB_ROOT/admin-releases/$RELEASE"
INCOMING="$WEB_ROOT/admin-releases/.incoming-$RELEASE"

test -n "$WEB_ROOT"
test -f "$ARCHIVE"
install -d -m 755 "$WEB_ROOT/admin-releases"
rm -rf -- "$INCOMING"
install -d -m 755 "$INCOMING/admin"
tar -xzf "$ARCHIVE" -C "$INCOMING/admin"
test -s "$INCOMING/admin/index.html"
chmod -R a+rX "$INCOMING"

if [ -d "$RELEASE_DIR" ]; then
  rm -rf -- "$RELEASE_DIR"
fi
mv "$INCOMING" "$RELEASE_DIR"

test -s "$RELEASE_DIR/admin/index.html"
rm -f -- "$WEB_ROOT/admin-current.next"
ln -s "admin-releases/$RELEASE" "$WEB_ROOT/admin-current.next"
mv -Tf "$WEB_ROOT/admin-current.next" "$WEB_ROOT/admin-current"
printf '%s\n' "$RELEASE" > "$WEB_ROOT/.admin-revision"
rm -f -- "$ARCHIVE"

nginx -t
curl --resolve maiscorehub.bakapiano.com:443:127.0.0.1 \
  -fsS https://maiscorehub.bakapiano.com/admin/ >/dev/null
curl --resolve maimai.bakapiano.com:443:127.0.0.1 \
  -fsS https://maimai.bakapiano.com/admin/ >/dev/null
echo "Admin static release activated: $RELEASE"

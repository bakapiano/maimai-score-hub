#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <local-archive> <remote-archive>" >&2
  exit 64
fi

local_archive="$1"
remote_archive="$2"
partial_archive="${remote_archive}.part"

: "${DEPLOY_HOST:?DEPLOY_HOST is required}"
: "${DEPLOY_USER:?DEPLOY_USER is required}"
: "${SSH_KEY:?SSH_KEY is required}"

DEPLOY_PORT="${DEPLOY_PORT:-22}"
UPLOAD_ATTEMPTS="${UPLOAD_ATTEMPTS:-3}"
UPLOAD_ATTEMPT_TIMEOUT_SECONDS="${UPLOAD_ATTEMPT_TIMEOUT_SECONDS:-600}"
UPLOAD_STALL_TIMEOUT_SECONDS="${UPLOAD_STALL_TIMEOUT_SECONDS:-120}"

if [ ! -f "$local_archive" ]; then
  echo "Archive not found: $local_archive" >&2
  exit 66
fi

case "$remote_archive" in
  /tmp/*.tgz) ;;
  *)
    echo "Remote archive must be a .tgz file directly under /tmp" >&2
    exit 64
    ;;
esac

for value in \
  "$DEPLOY_PORT" \
  "$UPLOAD_ATTEMPTS" \
  "$UPLOAD_ATTEMPT_TIMEOUT_SECONDS" \
  "$UPLOAD_STALL_TIMEOUT_SECONDS"; do
  if ! [[ "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "Upload numeric settings must be positive integers" >&2
    exit 64
  fi
done

for command_name in rsync ssh ssh-keyscan sha256sum timeout awk; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command is unavailable on the runner: $command_name" >&2
    exit 69
  fi
done

install -m 700 -d "$HOME/.ssh"
key_file="$HOME/.ssh/deploy_archive_key"
printf '%s\n' "$SSH_KEY" > "$key_file"
chmod 600 "$key_file"
trap 'rm -f -- "$key_file"' EXIT

timeout 30s ssh-keyscan -T 10 -p "$DEPLOY_PORT" "$DEPLOY_HOST" \
  >> "$HOME/.ssh/known_hosts"

ssh_options=(
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
  -o ConnectTimeout=20
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=2
  -o IPQoS=none
  -o Compression=no
  -p "$DEPLOY_PORT"
  -i "$key_file"
)
ssh_target="${DEPLOY_USER}@${DEPLOY_HOST}"

timeout 30s ssh "${ssh_options[@]}" "$ssh_target" \
  "command -v rsync >/dev/null && command -v sha256sum >/dev/null && test -w /tmp"

local_sha="$(sha256sum -- "$local_archive" | awk '{print $1}')"
local_size="$(wc -c < "$local_archive")"
local_size="${local_size//[[:space:]]/}"
echo "Uploading $(basename "$local_archive") (${local_size} bytes, sha256=${local_sha})"

existing_sha="$(
  timeout 30s ssh "${ssh_options[@]}" "$ssh_target" \
    "if [ -f '$remote_archive' ]; then sha256sum -- '$remote_archive' | awk '{print \$1}'; fi"
)"
if [ "$existing_sha" = "$local_sha" ]; then
  timeout 30s ssh "${ssh_options[@]}" "$ssh_target" \
    "rm -f -- '$partial_archive'"
  echo "Remote archive already matches; upload skipped"
  exit 0
fi

partial_size="$(
  timeout 30s ssh "${ssh_options[@]}" "$ssh_target" \
    "if [ -f '$partial_archive' ]; then stat -c '%s' '$partial_archive'; else echo 0; fi"
)"
if [ "$partial_size" -gt "$local_size" ]; then
  echo "Remote partial file is larger than the source; discarding it"
  timeout 30s ssh "${ssh_options[@]}" "$ssh_target" \
    "rm -f -- '$partial_archive'"
fi

printf -v rsync_shell '%q ' ssh "${ssh_options[@]}"
rsync_shell="${rsync_shell% }"

for attempt in $(seq 1 "$UPLOAD_ATTEMPTS"); do
  echo "Upload attempt ${attempt}/${UPLOAD_ATTEMPTS}"
  if timeout --signal=TERM --kill-after=20s \
    "${UPLOAD_ATTEMPT_TIMEOUT_SECONDS}s" \
    rsync \
      --partial \
      --append-verify \
      --timeout="$UPLOAD_STALL_TIMEOUT_SECONDS" \
      --human-readable \
      --info=progress2 \
      -e "$rsync_shell" \
      -- "$local_archive" "${ssh_target}:${partial_archive}"; then
    remote_sha="$(
      timeout 30s ssh "${ssh_options[@]}" "$ssh_target" \
        "sha256sum -- '$partial_archive' | awk '{print \$1}'"
    )"
    if [ "$remote_sha" = "$local_sha" ]; then
      finalized_sha="$(
        timeout 30s ssh "${ssh_options[@]}" "$ssh_target" \
          "mv -f -- '$partial_archive' '$remote_archive' && sha256sum -- '$remote_archive' | awk '{print \$1}'"
      )"
      if [ "$finalized_sha" = "$local_sha" ]; then
        echo "Upload verified and finalized: $remote_archive"
        exit 0
      fi
    fi

    echo "Remote checksum mismatch; discarding the invalid partial file" >&2
    timeout 30s ssh "${ssh_options[@]}" "$ssh_target" \
      "rm -f -- '$partial_archive'"
  else
    echo "Upload attempt ${attempt} interrupted; partial data is retained" >&2
  fi

  if [ "$attempt" -lt "$UPLOAD_ATTEMPTS" ]; then
    sleep $((attempt * 10))
  fi
done

echo "Upload failed after ${UPLOAD_ATTEMPTS} attempts" >&2
exit 1

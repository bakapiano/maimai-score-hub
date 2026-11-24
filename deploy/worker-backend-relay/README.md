# Server 101 backend relay

Host-only SSH keys and pinned host keys live in `/etc/maimai-backend-relay/`.
The SSH connection goes from 101 through Server 2 to Server 5. Dedicated
restricted accounts permit only the jump to Server 5 SSH, then loopback API
8090 and Redis 6379. No credentials or runtime `.env` are tracked here.

The host helper `/usr/local/libexec/maimai-backend-relay-control` installs
DNAT only for the `worker_default` and `maimai-score-hub-sdgb-worker_default`
Docker bridges, targeting Server 5 port 8090 or 6379. Listeners bind to
`172.17.0.1:18090` and `172.17.0.1:16379`; host INPUT rules reject access
outside the permitted bridges/loopback. Runtime endpoint configuration is
unchanged, including across normal worker deployments.

## Lifecycle fix

Install `10-route-lifecycle.conf` in
`/etc/systemd/system/maimai-backend-relay.service.d/`. Retire the separate
`maimai-backend-relay-route.service` with `systemctl disable --now`, reload
systemd, then restart `maimai-backend-relay.service`.

The previous route oneshot had `Requires=maimai-backend-relay.service`.
An SSH restart stopped it and removed the routing hook. A failed initial
reconnect prevented it from being started again even after SSH recovered.
The SSH service now owns route installation in its own `ExecStartPost`:
API and Redis readiness plus route setup must succeed on every restart.
Routing remains in place during SSH outages (fail closed). Docker restarts
also restart this unit and reapply the rules. A manual Docker network
replacement without restarting Docker requires restarting the relay.

SSH heartbeats remain 15 seconds / 3 missed replies, connection timeout
10 seconds, and systemd retries indefinitely from 3 up to 30 seconds.
`ExecStartPost` runs as root; the SSH process stays under `msh-relay`.

## Verification and rollback

Verify both workers can GET their configured API health endpoint and issue
an authenticated Redis PING using their existing host-only environment.
After traffic is routed, test SSH process failure AND a failed reconnect;
check that the scoped PREROUTING hook remains and both checks recover.
Do not restart workers or interrupt the independent reverse SSH service.

To deliberately revert to direct routing, stop/disable the relay, then run
`sudo /usr/local/libexec/maimai-backend-relay-control route-off`.
Stopping SSH alone deliberately does not remove routing. Keep a backup of
the previous unit and helper when installing host configuration.

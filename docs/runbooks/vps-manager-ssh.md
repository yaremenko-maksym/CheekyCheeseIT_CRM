# Restricted read-only SSH for a manager on the prod VPS

**For:** the owner, once per manager, and again to revoke.
**Source:** `docs/superpowers/specs/2026-11-27-manager-role-design.md` §7.
**Every step is owner-run** as an admin on the VPS (`ssh crm-vps`). Agents have no SSH to the host
(`docs/runbooks/human-only.md`). Deploys stay merge to CD; this account never deploys.

> **Placeholders.** This repo is public. `<manager-key.pub>` is the manager's public key,
> `<admin>` is your own admin login, `<host>` is the VPS address. Never paste a real address, key or
> user name into the repo.

## What the account can do

| Can                                                    | Cannot                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `status`: name and status of the CRM containers        | open a shell, a TTY, SFTP/SCP, or any port forward                     |
| `logs api` / `logs nginx` (last N lines, N up to 2000) | run `docker`, `sudo`, `psql`, or any command not in the allowlist      |
| `help`                                                 | read `.env.production`, DB data, the docker socket, other users' files |

## How it works (and why there is a root exporter)

Container logs are readable only through the docker socket, and the socket is root-equivalent. The
account must not get it (no `docker` group, no `sudo`). So a root-owned systemd timer copies a
bounded tail of each allowlisted container's log into plain files; the manager's forced command can
only `tail` those files. Consequence: logs are up to about one minute stale.

```
manager key --ssh--> sshd (ForceCommand + authorized_keys command=)
                       -> /usr/local/bin/crm-manager-shell.sh (allowlist)
                          -> tail /var/lib/crm-manager-logs/{api,nginx}.log, status.txt
root timer (every 60 s) -> /usr/local/sbin/crm-log-export.sh -> writes those files
```

**Decision before you start (A3, yours).** `api` logs may contain identifiers (emails, names) and
`nginx` logs contain client IPs. Read a sample of each (`docker logs --tail 200 crm-api`) and
decide whether the manager may see them. `postgres` and `signal-plus` logs are deliberately NOT in
the allowlist (query text, phone numbers). To add a service later, edit the two scripts below in
step with each other.

## 1. Create the user and group

Container names `crm-api`, `crm-nginx`, `crm-postgres` and the compose path `/opt/crm` come from
`docs/runbooks/deployment.md` and `vps-disk-hygiene.md`.

```bash
groupadd --system crm-manager-logs
useradd --create-home --shell /bin/bash --comment "CRM manager (read-only logs)" crm-manager
usermod --append --groups crm-manager-logs crm-manager
passwd --lock crm-manager        # key-only login; no password exists
id crm-manager                   # expect groups: crm-manager, crm-manager-logs ONLY
```

Do not add the user to `docker`, `sudo`, `adm` or any other group.

## 2. The exporter (root, runs on a timer)

```bash
install -d -m 0750 -o root -g crm-manager-logs /var/lib/crm-manager-logs

cat > /usr/local/sbin/crm-log-export.sh <<'EOF'
#!/bin/bash
# Root-run. Copies a bounded log tail per allowlisted container into files the manager can read.
set -euo pipefail
OUT=/var/lib/crm-manager-logs
GROUP=crm-manager-logs
declare -A CONTAINER=( [api]=crm-api [nginx]=crm-nginx )

publish() { # publish <tmpfile> <final name>
  chmod 0640 "$1"
  chown "root:${GROUP}" "$1"
  mv -f "$1" "${OUT}/$2"
}

for svc in "${!CONTAINER[@]}"; do
  tmp=$(mktemp -p "$OUT" ".${svc}.XXXXXX")
  if ! docker logs --timestamps --tail 2000 "${CONTAINER[$svc]}" >"$tmp" 2>&1; then
    echo "export failed for ${svc} at $(date -u +%FT%TZ)" >"$tmp"
  fi
  publish "$tmp" "${svc}.log"
done

tmp=$(mktemp -p "$OUT" ".status.XXXXXX")
{
  echo "exported at $(date -u +%FT%TZ)"
  docker ps -a --filter name=crm- --filter name=signal-plus --format 'table {{.Names}}\t{{.Status}}'
} >"$tmp" 2>&1 || echo "export failed at $(date -u +%FT%TZ)" >"$tmp"
publish "$tmp" status.txt
EOF
chown root:root /usr/local/sbin/crm-log-export.sh
chmod 0755 /usr/local/sbin/crm-log-export.sh

cat > /etc/systemd/system/crm-log-export.service <<'EOF'
[Unit]
Description=Export allowlisted CRM container logs for the read-only manager account

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/crm-log-export.sh
EOF

cat > /etc/systemd/system/crm-log-export.timer <<'EOF'
[Unit]
Description=Run the CRM log export every minute

[Timer]
OnBootSec=30s
OnUnitActiveSec=60s

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now crm-log-export.timer
systemctl start crm-log-export.service
```

## 3. The forced-command wrapper (the allowlist)

Root-owned and not writable by the manager. It never evaluates the client's string: the string is
only split into words and compared to fixed values.

```bash
cat > /usr/local/bin/crm-manager-shell.sh <<'EOF'
#!/bin/bash
# Forced command for the read-only manager. Allowlist: help | status | logs <api|nginx> [lines<=2000].
set -euo pipefail
LOG_DIR=/var/lib/crm-manager-logs

deny() { echo "denied: use 'help'" >&2; exit 2; }

read -r -a args <<<"${SSH_ORIGINAL_COMMAND:-help}"
[ "${#args[@]}" -ge 1 ] && [ "${#args[@]}" -le 3 ] || deny

case "${args[0]}" in
  help)
    [ "${#args[@]}" -eq 1 ] || deny
    echo "commands: help | status | logs <api|nginx> [lines, 1-2000, default 200]"
    ;;
  status)
    [ "${#args[@]}" -eq 1 ] || deny
    exec cat -- "${LOG_DIR}/status.txt"
    ;;
  logs)
    svc="${args[1]:-}"
    n="${args[2]:-200}"
    [[ "$svc" =~ ^(api|nginx)$ ]] || deny
    [[ "$n" =~ ^[0-9]{1,4}$ ]] && [ "$n" -ge 1 ] && [ "$n" -le 2000 ] || deny
    exec tail -n "$n" -- "${LOG_DIR}/${svc}.log"
    ;;
  *) deny ;;
esac
EOF
chown root:root /usr/local/bin/crm-manager-shell.sh
chmod 0755 /usr/local/bin/crm-manager-shell.sh
```

## 4. The key: `command=` + `restrict`, in a root-owned file

The key file lives outside the user's home, owned by root, so the account can never edit its own
restrictions.

```bash
install -d -m 0755 -o root -g root /etc/ssh/crm-manager
printf '%s\n' 'restrict,command="/usr/local/bin/crm-manager-shell.sh" <contents of manager-key.pub>' \
  > /etc/ssh/crm-manager/authorized_keys
chown root:root /etc/ssh/crm-manager/authorized_keys
chmod 0644 /etc/ssh/crm-manager/authorized_keys
```

`restrict` turns off PTY, port, agent and X11 forwarding and `~/.ssh/rc` for this key. Optionally
prefix `from="<manager-ip-or-cidr>",` before `restrict` if the manager has a stable address.

## 5. sshd: a second, independent lock

```bash
cat > /etc/ssh/sshd_config.d/50-crm-manager.conf <<'EOF'
Match User crm-manager
    AuthorizedKeysFile /etc/ssh/crm-manager/authorized_keys
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTTY no
    PermitTunnel no
    PermitUserRC no
    ForceCommand /usr/local/bin/crm-manager-shell.sh
EOF
sshd -t && echo "sshd config OK"
```

Keep your current admin SSH session open. Only if `sshd config OK` printed:
`systemctl reload ssh`, then open a second admin session to confirm you can still log in.

The firewall (`origin-mtls-and-firewall.md`) is unchanged: port 22 is already open for the owner.

## 6. How each denial works

| Asset              | Why the account cannot reach it                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `.env.production`  | File is mode 600 owned by the deploy user, in `/opt/crm`; the account is neither that user nor in its group. The wrapper has no `cat <path>`. |
| Database           | `postgres` is reachable only inside the docker network (no published host port). No credentials are readable; the wrapper has no `psql`.      |
| Docker socket      | The socket is `root:docker`, mode 660; the account is not in `docker`. Logs come from exported files, never from the socket.                  |
| Root / other users | No `sudo`, no `adm`, no shell. Forced command plus `ForceCommand` plus `restrict` all point at the allowlist wrapper.                         |

## 7. Verification checklist (owner)

Run as the admin. Expected output is in the right column; any difference means stop and fix
before giving the manager the key.

| #   | Command (admin session)                                                          | Expected                                                                                           |
| --- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | `id crm-manager`                                                                 | groups only `crm-manager` and `crm-manager-logs`                                                   |
| 2   | `getent group docker sudo adm`                                                   | `crm-manager` appears in none of the member lists                                                  |
| 3   | `sudo -l -U crm-manager`                                                         | `User crm-manager is not allowed to run sudo`                                                      |
| 4   | `sudo -u crm-manager cat /opt/crm/.env.production`                               | `Permission denied`                                                                                |
| 5   | `sudo -u crm-manager docker ps`                                                  | `permission denied ... docker.sock` (or `command not found`)                                       |
| 6   | `stat -c '%a %U:%G' /var/run/docker.sock /opt/crm/.env.production`               | `660 root:docker` and `600 <deploy-user>:<group>`                                                  |
| 7   | `ss -ltnH 'sport = :5432'`                                                       | empty (Postgres is not published on the host)                                                      |
| 8   | `ls -l /usr/local/bin/crm-manager-shell.sh /etc/ssh/crm-manager/authorized_keys` | both owned `root root`, not group/world writable                                                   |
| 9   | `systemctl list-timers crm-log-export.timer --no-pager`                          | the timer is listed with a next run time                                                           |
| 10  | `ls -l /var/lib/crm-manager-logs`                                                | `api.log`, `nginx.log`, `status.txt`, `-rw-r----- root crm-manager-logs`, updated within 2 minutes |

Then from the manager's machine (or yours with the manager's key), `ssh -i <key> crm-manager@<host> <cmd>`:

| #   | Command                                        | Expected                                             |
| --- | ---------------------------------------------- | ---------------------------------------------------- |
| 11  | `help`                                         | the one-line command list                            |
| 12  | `status`                                       | `exported at ...` then the CRM containers, `Up`      |
| 13  | `logs api 50`                                  | 50 log lines                                         |
| 14  | `logs postgres`                                | `denied: use 'help'`, exit code 2                    |
| 15  | `logs api; id`                                 | `denied` (`api;` is not an allowlisted service name) |
| 16  | `docker ps` and `cat /opt/crm/.env.production` | `denied`                                             |
| 17  | `logs api 99999`                               | `denied`                                             |
| 18  | plain `ssh -i <key> crm-manager@<host>`        | prints the help line and exits (no shell prompt)     |
| 19  | `ssh -N -L 5432:127.0.0.1:5432 ...`            | forwarding refused / connection closes               |
| 20  | `sftp -i <key> crm-manager@<host>`             | fails (the allowlist rejects the sftp subsystem)     |

Also confirm password login is refused: `ssh -o PubkeyAuthentication=no crm-manager@<host>` fails.

## 8. Revoke

Order matters: cut access first, clean up second.

```bash
# 1. Remove the key (instant effect for new logins).
: > /etc/ssh/crm-manager/authorized_keys

# 2. Lock the account and end live sessions.
usermod --lock --expiredate 1 crm-manager
loginctl terminate-user crm-manager 2>/dev/null || pkill -KILL -u crm-manager

# 3. Confirm nothing is left.
who | grep crm-manager || echo "no sessions"
```

Cleanup (same day):

```bash
rm -f /etc/ssh/sshd_config.d/50-crm-manager.conf && sshd -t && systemctl reload ssh
userdel --remove crm-manager
rm -rf /etc/ssh/crm-manager
# Only when NO other manager uses it:
systemctl disable --now crm-log-export.timer
rm -f /etc/systemd/system/crm-log-export.{service,timer} /usr/local/sbin/crm-log-export.sh /usr/local/bin/crm-manager-shell.sh
rm -rf /var/lib/crm-manager-logs
groupdel crm-manager-logs
systemctl daemon-reload
```

Verify: `id crm-manager` reports `no such user`, and `ssh -i <old key> crm-manager@<host>` is refused.

If the manager's key leaked rather than the person leaving: do steps 1-2, then generate a new key pair
for the person and redo section 4 only. The log files held nothing but what the allowlist already
exposed, so no other secret rotates; if the sample review in "Decision before you start" found
identifiers in `api` logs, treat those as seen.

## Related

- `docs/runbooks/human-only.md` — registry of owner-only steps (item 12 points here).
- `docs/runbooks/deployment.md` — host layout, `/opt/crm`, container names, `.env.production`.
- `docs/runbooks/vps-disk-hygiene.md` — compose log limits that bound the exported tail.
- `docs/runbooks/origin-mtls-and-firewall.md` — the perimeter this account sits behind.

#!/usr/bin/env bash
# test-check-extraction-worker-compose.sh - both directions for the extraction isolation guard.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

# The test-only interpolation names below (CRM_GUARD_T_*). Unset here, so every guard child runs
# with them unset, whatever the developer's shell exports (a bare X or M once changed a case's result).
unset CRM_GUARD_T_LOG CRM_GUARD_T_MEM CRM_GUARD_T_NODE_ENV CRM_GUARD_T_USER CRM_GUARD_T_REPO \
  CRM_GUARD_T_TAG CRM_GUARD_T_NET CRM_GUARD_T_SUBNET CRM_GUARD_T_VOL CRM_GUARD_T_OPT CRM_GUARD_T_NAME

GUARD="$GUARD_DIR/check-extraction-worker-compose.mjs"
EXTRACTION="$REPO_ROOT/docker-compose.extraction.yml"
PROD="$REPO_ROOT/docker-compose.prod.yml"
GHCR="$REPO_ROOT/docker-compose.ghcr.yml"
SCRIPT="$REPO_ROOT/scripts/devops/deploy-stack-on-vps.sh"
WORKFLOW="$REPO_ROOT/.github/workflows/deploy.yml"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# guard_with [--extraction F] [--prod F] [--script F] [--workflow F]: the real files except the named one.
guard_with() {
  local e="$EXTRACTION" p="$PROD" s="$SCRIPT" w="$WORKFLOW"
  while [ $# -gt 0 ]; do
    case "$1" in
      --extraction) e="$2" ;;
      --prod) p="$2" ;;
      --script) s="$2" ;;
      --workflow) w="$2" ;;
    esac
    shift 2
  done
  node "$GUARD" --extraction "$e" --deploy "$p" --deploy "$GHCR" --names "$s" --names "$w"
}

# mutate <source> "<name>" <sed script | -e script...>: a copy with one edit, under its original basename; prints its path.
mutate() {
  local src="$1" name="$2"
  shift 2
  mkdir -p "$TMP/$name"
  sed "$@" "$src" > "$TMP/$name/$(basename "$src")"
  # A sed that matched nothing would test the unmodified file, and pass for the wrong reason.
  if cmp -s "$src" "$TMP/$name/$(basename "$src")"; then
    echo "mutation $name changed nothing" >&2
    return 1
  fi
  echo "$TMP/$name/$(basename "$src")"
}
ex() { mutate "$EXTRACTION" "$@"; }

WORKER='/^    command: \[.node., .dist\/extraction-worker\/main.\]/'
WK='/^  extraction-worker:/,/^volumes:/'
# A second service, injected before `volumes:`. (Text inserted by `i` is not matched by later sed
# commands, so a test that needs an extra line on it writes the whole insertion itself.)
SIDECAR='/^volumes:$/i\
  sidecar:\
    image: busybox\
'

echo "== test-check-extraction-worker-compose.sh =="

assert_green "the real files pass" --contains "isolation OK" -- guard_with

# ── the separate project: the worker ──
F="$(ex worker-ports "${WORKER}a\\
    ports: ['3100:3100']")"
assert_red "worker gaining ports: is refused" --contains "extraction-worker must not publish ports" -- guard_with --extraction "$F"

F="$(ex worker-expose "${WORKER}a\\
    expose: ['3100']")"
assert_red "worker declaring expose is refused" --contains "extraction-worker must not declare expose" -- guard_with --extraction "$F"

# compose refuses network_mode beside networks:, so the mutation swaps one for the other.
F="$(ex worker-host "$WK"' { s/^    networks:$/    network_mode: host/; /^      entry:$/d; /^        # /d; /^        aliases:/d; /^      egress: {}$/d; }')"
assert_red "worker with network_mode: host is refused" --contains "network_mode" -- guard_with --extraction "$F"

F="$(ex worker-privileged "${WORKER}a\\
    privileged: true")"
assert_red "a privileged worker is refused" --contains "extraction-worker must not be privileged" -- guard_with --extraction "$F"

F="$(ex worker-cap-add "${WORKER}a\\
    cap_add: [NET_ADMIN]")"
assert_red "worker adding a capability is refused" --contains "extraction-worker must not add capabilities" -- guard_with --extraction "$F"

F="$(ex keep-caps "$WK"' { /^    cap_drop:$/d; /^      - ALL$/d; }')"
assert_red "worker keeping capabilities is refused" --contains "extraction-worker must drop all capabilities" -- guard_with --extraction "$F"

F="$(ex no-nnp "$WK"' { /^    security_opt:$/d; /^      - no-new-privileges:true$/d; }')"
assert_red "worker without no-new-privileges is refused" --contains "extraction-worker must set no-new-privileges" -- guard_with --extraction "$F"

F="$(ex worker-cpus "$WK"' s/^    cpus: 0.5$/    cpus: 1.0/')"
assert_red "worker cpus drifting is refused" --contains "extraction-worker cpus must be 0.5" -- guard_with --extraction "$F"

F="$(ex worker-mem "$WK"' s/^    mem_limit: 512m$/    mem_limit: 1024m/')"
assert_red "worker memory drifting is refused" --contains "extraction-worker mem_limit" -- guard_with --extraction "$F"

F="$(ex worker-swap "$WK"' s/^    memswap_limit: 512m$/    memswap_limit: 1024m/')"
assert_red "worker with swap allowed is refused" --contains "memswap_limit must equal" -- guard_with --extraction "$F"

F="$(ex worker-pids "$WK"' { /^    pids_limit: 64$/d; }')"
assert_red "worker without a pids limit is refused" --contains "extraction-worker pids_limit must be 64" -- guard_with --extraction "$F"

F="$(ex worker-rw "$WK"' { /^    read_only: true$/d; }')"
assert_red "worker with a writable root filesystem is refused" --contains "extraction-worker must run with read_only" -- guard_with --extraction "$F"

F="$(ex worker-no-state "$WK"' { /^    volumes:$/d; /^      - worker_state:\/var\/lib\/extraction-worker$/d; }')"
assert_red "worker losing its state volume is refused" --contains "must keep its state volume" -- guard_with --extraction "$F"

# ── the separate project: what the worker may hold or reach (D2, D3, CR-M-2) ──
F="$(ex docker-sock '/^      - worker_state:\/var\/lib\/extraction-worker$/a\
      - /var/run/docker.sock:/var/run/docker.sock')"
assert_red "a bind mount of the docker socket is refused" --contains "must mount only its state volume (found: bind" -- guard_with --extraction "$F"

F="$(ex second-volume -e '/^      - worker_state:\/var\/lib\/extraction-worker$/a\
      - other:/data' -e '/^  worker_state: {}$/i\
  other: {}')"
assert_red "a second named volume is refused" --contains "must mount only its state volume (found: volume other" -- guard_with --extraction "$F"

F="$(ex env-file-prod 's/^      - .env.extraction-worker$/      - .env.production/')"
assert_red "an env_file other than .env.extraction-worker is refused" --contains "env_file must be exactly .env.extraction-worker (found: .env.production)" -- guard_with --extraction "$F"

F="$(ex env-file-extra '/^      - .env.extraction-worker$/a\
      - .env.production')"
assert_red "a second env_file is refused" --contains "env_file must be exactly .env.extraction-worker" -- guard_with --extraction "$F"

F="$(ex env-file-none "$WK"' { /^    env_file:$/d; /^      - .env.extraction-worker$/d; }')"
assert_red "no env_file is refused" --contains "env_file must be exactly .env.extraction-worker (found: none)" -- guard_with --extraction "$F"

F="$(ex env-db-url '/^      NODE_ENV: production$/a\
      DATABASE_URL: postgresql://x@postgres/crm_db')"
assert_red "a DATABASE_URL in the worker's environment is refused" --contains "must hold no database setting (found: DATABASE_URL)" -- guard_with --extraction "$F"

F="$(ex env-pg-pw '/^      NODE_ENV: production$/a\
      POSTGRES_PASSWORD: x')"
assert_red "a POSTGRES_* key in the worker's environment is refused" --contains "must hold no database setting (found: POSTGRES_PASSWORD)" -- guard_with --extraction "$F"

for u in root "'0'" "'0:0'" "''"; do
  F="$(ex "user-$(echo "$u" | tr -dc 'a-z0-9')x" "$WK s/^    user: node\$/    user: $u/")"
  assert_red "worker running as user $u is refused" --contains "must run as user node" -- guard_with --extraction "$F"
done
F="$(ex user-unset "$WK"' { /^    user: node$/d; }')"
assert_red "worker with no user (image default unchecked) is refused" --contains "must run as user node, the image's own (found: unset)" -- guard_with --extraction "$F"

F="$(ex extra-hosts "${WORKER}a\\
    extra_hosts: ['metadata:169.254.169.254']")"
assert_red "extra_hosts on the worker is refused" --contains "must not set extra_hosts" -- guard_with --extraction "$F"

F="$(ex tmp-exec "$WK"' s/,noexec,nosuid$//')"
assert_red "a /tmp without noexec,nosuid is refused" --contains "tmpfs must be /tmp only, with noexec and nosuid" -- guard_with --extraction "$F"

F="$(ex no-tmp "$WK"' { /^    tmpfs:$/d; /^      - \/tmp:/d; }')"
assert_red "no /tmp tmpfs is refused" --contains "must keep its /tmp tmpfs" -- guard_with --extraction "$F"

for key in pid ipc; do
  F="$(ex "$key-host" "${WORKER}a\\
    $key: host")"
  assert_red "worker with $key: host is refused" --contains "must not set $key (host)" -- guard_with --extraction "$F"
done

for opt in seccomp=unconfined seccomp:unconfined apparmor=unconfined label=disable; do
  F="$(ex "secopt-$(echo "$opt" | tr -dc 'a-z')" '/^      - no-new-privileges:true$/a\
      - '"$opt")"
  assert_red "security_opt $opt is refused" --contains "must set no security_opt but no-new-privileges (found: $opt)" -- guard_with --extraction "$F"
done

F="$(ex worker-profile "${WORKER}a\\
    profiles: ['extraction']")"
assert_red "worker hiding behind a profile is refused" --contains "must not hide behind a profile" -- guard_with --extraction "$F"

# ── the separate project: its networks ──
F="$(ex worker-leaves-entry "$WK"' { /^      entry:$/d; /^        # /d; /^        aliases:/d; }')"
assert_red "worker leaving the entry network is refused" --contains "extraction-worker must be on entry and egress only" -- guard_with --extraction "$F"

F="$(ex worker-leaves-egress "$WK"' { /^      egress: {}$/d; }')"
assert_red "worker leaving the egress network is refused" --contains "extraction-worker must be on entry and egress only" -- guard_with --extraction "$F"

F="$(ex third-net -e '$a\
  extra:\
    driver: bridge' -e "$WK"' s/^      egress: {}$/      egress: {}\
      extra: {}/')"
assert_red "a third network on the worker is refused" --contains "unexpected network extra" -- guard_with --extraction "$F"

F="$(ex open-entry '/^  entry:$/,/^  # Outbound/ s/^    internal: true$/    internal: false/')"
assert_red "entry network losing internal: true is refused" --contains "network entry must be internal: true" -- guard_with --extraction "$F"

F="$(ex external-entry '/^  entry:$/,/^  # Outbound/ s/^    driver: bridge$/    external: true/')"
assert_red "an external entry network is refused" --contains "must not be external" -- guard_with --extraction "$F"

F="$(ex renamed-entry 's/^    name: crm-extraction-entry$/    name: other/')"
assert_red "renaming the entry network is refused" --contains "must keep the name" -- guard_with --extraction "$F"

F="$(ex no-egress -e '/^  # Outbound to the hosted/,$d' -e "$WK"' { /^      egress: {}$/d; }')"
assert_red "no egress network is refused" --contains "network egress is missing" -- guard_with --extraction "$F"

F="$(ex internal-egress '/^  egress:$/a\
    internal: true')"
assert_red "an internal egress network is refused" --contains "network egress must not be internal" -- guard_with --extraction "$F"

# The main stack's backend network, where postgres lives: a fixed name would share it.
F="$(ex shared-egress '/^  egress:$/a\
    name: crm_backend')"
assert_red "an egress network named after a main-stack network is refused" --contains "must resolve to crm-extraction_egress" -- guard_with --extraction "$F"

F="$(ex external-egress '/^  egress:$/,$ s/^    driver: bridge$/    external: true\
    name: crm-extraction_egress/')"
assert_red "an external egress network is refused" --contains "network egress must not be external" -- guard_with --extraction "$F"

F="$(ex no-alias "$WK"' { /^        aliases: \[crm-extraction-worker\]$/d; }')"
assert_red "the worker losing its crm-extraction-worker alias is refused" --contains "must carry exactly the alias crm-extraction-worker on entry" -- guard_with --extraction "$F"

F="$(ex other-subnet 's/^        - subnet: 10\.250\.17\.0\/28$/        - subnet: 10.250.18.0\/28/')"
assert_red "an egress subnet other than the pinned one is refused" --contains "must pin the subnet 10.250.17.0/28 (found: 10.250.18.0/28)" -- guard_with --extraction "$F"

F="$(ex no-subnet '/^    ipam:$/,/^        - subnet:/d')"
assert_red "an egress network without the pinned subnet is refused" --contains "must pin the subnet 10.250.17.0/28 (found: none)" -- guard_with --extraction "$F"

F="$(ex sidecar-on-egress '/^volumes:$/i\
  sidecar:\
    image: busybox\
    networks: [egress]\
')"
assert_red "another service joining the egress network is refused" --contains "service sidecar must not join egress" -- guard_with --extraction "$F"

F="$(ex sidecar-on-entry '/^volumes:$/i\
  sidecar:\
    image: busybox\
    networks: [entry]\
')"
assert_red "another service joining the entry network is refused" --contains "service sidecar must not join entry" -- guard_with --extraction "$F"

F="$(ex sidecar-shares-ns '/^volumes:$/i\
  sidecar:\
    image: busybox\
    network_mode: "service:extraction-worker"\
')"
assert_red "a service sharing the worker's namespace is refused" --contains "must not share another service's network namespace" -- guard_with --extraction "$F"

# ── the separate project: services, pin, name ──
F="$(ex extra-service "$SIDECAR")"
assert_red "an unexpected service in the project is refused" --contains "unexpected service sidecar" -- guard_with --extraction "$F"

F="$(ex profiled-runtime '/^volumes:$/i\
  sidecar:\
    image: busybox\
    profiles: ["provision"]\
')"
assert_red "a service behind a profile in the project is refused" --contains "unexpected service sidecar" -- guard_with --extraction "$F"

F="$(ex default-tag 's/\${EXTRACTION_WORKER_IMAGE_TAG:?pin the worker image tag}/${EXTRACTION_WORKER_IMAGE_TAG:-main}/')"
assert_red "an unset image tag that does not refuse is itself refused" --contains "unset EXTRACTION_WORKER_IMAGE_TAG" -- guard_with --extraction "$F"

F="$(ex renamed-project 's/^name: crm-extraction$/name: crm/')"
assert_red "losing its own project name is refused" --contains "project must be named" -- guard_with --extraction "$F"

# ── G2 / CR-M-3: the worker's keys are an allow-list; each of these was a deny-list gap ──
i=0
while IFS= read -r line; do
  i=$((i + 1))
  key="${line%%:*}"
  F="$(ex "key-$i-$key" "${WORKER}a\\
    $line")"
  assert_red "worker setting $key is refused" --contains "extraction-worker must not set $key: not in the reviewed key allow-list" -- guard_with --extraction "$F"
done <<'KEYS'
devices: ['/dev/sda:/dev/sda']
group_add: ['disk']
volumes_from: ['container:crm-api-1']
sysctls: {net.ipv4.ip_forward: '1'}
cgroup_parent: /
oom_kill_disable: true
runtime: runc
entrypoint: ['sh', '-c']
stop_grace_period: 1s
KEYS

# A service-level secret needs its top-level source, a host path read into the worker.
F="$(ex secret-file -e "${WORKER}a\\
    secrets: [hostkey]" -e '/^networks:$/i\
secrets:\
  hostkey:\
    file: /etc/shadow\
')"
assert_red "worker mounting a file: secret is refused" --contains "extraction-worker must not set secrets: not in the reviewed key allow-list" -- guard_with --extraction "$F"
assert_red "a top-level secrets block is refused" --contains "must not declare top-level secrets" -- guard_with --extraction "$F"

F="$(ex config-file -e "${WORKER}a\\
    configs: [hostcfg]" -e '/^networks:$/i\
configs:\
  hostcfg:\
    file: /etc/hostname\
')"
assert_red "worker mounting a config is refused" --contains "extraction-worker must not set configs: not in the reviewed key allow-list" -- guard_with --extraction "$F"
assert_red "a top-level configs block is refused" --contains "must not declare top-level configs" -- guard_with --extraction "$F"

# ── G1: the top-level side of the state volume decides what it is ──
F="$(ex state-bind 's/^  worker_state: {}$/  worker_state:\
    driver: local\
    driver_opts:\
      type: none\
      o: bind\
      device: \//')"
assert_red "a state volume bound to the host root by driver_opts is refused" --contains "volume worker_state must set nothing (found: driver_opts)" -- guard_with --extraction "$F"

for kv in 'driver: local' 'external: true' 'name: crm_pgdata' 'labels: {a: b}'; do
  k="${kv%%:*}"
  F="$(ex "state-$k" "s/^  worker_state: {}\$/  worker_state:\\
    $kv/")"
  assert_red "a state volume setting $k is refused" --contains "volume worker_state must set nothing (found: $k)" -- guard_with --extraction "$F"
done

# ── G3: tmpfs options are parsed, so a later option cannot undo an earlier one ──
for opt in exec suid dev; do
  F="$(ex "tmp-$opt" "$WK"" s/,noexec,nosuid\$/,noexec,nosuid,$opt/")"
  assert_red "a /tmp re-enabling $opt is refused" --contains "tmpfs must be /tmp only, with noexec and nosuid, and no exec, suid or dev" -- guard_with --extraction "$F"
done
F="$(ex tmp-prefix "$WK"' s/^      - \/tmp:size/      - \/tmpx:size/')"
assert_red "a tmpfs path that only starts with /tmp is refused" --contains "tmpfs must be /tmp only" -- guard_with --extraction "$F"

# ── H1: the entry aliases are exactly the one the API calls; egress has none ──
F="$(ex alias-postgres 's/^        aliases: \[crm-extraction-worker\]$/        aliases: [crm-extraction-worker, postgres, api]/')"
assert_red "extra aliases (postgres, api) on the entry network are refused" --contains "must carry exactly the alias crm-extraction-worker on entry (found: crm-extraction-worker, postgres, api)" -- guard_with --extraction "$F"

F="$(ex alias-only-other 's/^        aliases: \[crm-extraction-worker\]$/        aliases: [postgres]/')"
assert_red "an alias other than crm-extraction-worker is refused" --contains "must carry exactly the alias crm-extraction-worker on entry (found: postgres)" -- guard_with --extraction "$F"

F="$(ex alias-egress 's/^      egress: {}$/      egress:\
        aliases: [postgres]/')"
assert_red "an alias on the egress network is refused" --contains "must carry no alias on egress (found: postgres)" -- guard_with --extraction "$F"

# ── H2: network definitions: bridge driver, no driver_opts, no IPv6, key allow-list ──
for drv in macvlan ipvlan overlay host; do
  F="$(ex "egress-$drv" "/^  egress:\$/,\$ s/^    driver: bridge\$/    driver: $drv/")"
  assert_red "an egress network on the $drv driver is refused" --contains "network egress must use the bridge driver (found: $drv)" -- guard_with --extraction "$F"
done
F="$(ex entry-macvlan '/^  entry:$/,/^  # Outbound/ s/^    driver: bridge$/    driver: macvlan/')"
assert_red "an entry network on the macvlan driver is refused" --contains "network entry must use the bridge driver (found: macvlan)" -- guard_with --extraction "$F"

F="$(ex egress-ipv6 '/^  egress:$/a\
    enable_ipv6: true')"
assert_red "an egress network with enable_ipv6: true is refused" --contains "network egress must not enable IPv6" -- guard_with --extraction "$F"
F="$(ex entry-ipv6 '/^  entry:$/a\
    enable_ipv6: true')"
assert_red "an entry network with enable_ipv6: true is refused" --contains "network entry must not enable IPv6" -- guard_with --extraction "$F"
F="$(ex egress-ipv6-off '/^  egress:$/a\
    enable_ipv6: false')"
assert_green "enable_ipv6: false is the default and passes" --contains "isolation OK" -- guard_with --extraction "$F"

F="$(ex egress-driver-opts '/^    driver: bridge$/{
x
s/^/x/
/^xx$/{
x
a\
    driver_opts:\
      com.docker.network.bridge.name: docker0
b
}
x
}')"
assert_red "driver_opts on a network are refused" --contains "must not set driver_opts: not in the reviewed key allow-list" -- guard_with --extraction "$F"

for kv in 'attachable: true' 'labels: {a: b}'; do
  k="${kv%%:*}"
  F="$(ex "net-$k" "/^  egress:\$/a\\
    $kv")"
  assert_red "a network key $k outside the allow-list is refused" --contains "network egress must not set $k: not in the reviewed key allow-list" -- guard_with --extraction "$F"
done
# J7: a compose release that does not know enable_ipv4 refuses the schema (exit 2, "could not
# resolve"); that is not this finding, so it must not count as a pass.
F="$(ex net-enable_ipv4 '/^  egress:$/a\
    enable_ipv4: true')"
assert_red "a network key enable_ipv4 outside the allow-list is refused by the allow-list" --contains "network egress must not set enable_ipv4: not in the reviewed key allow-list" --not-contains "could not resolve" -- guard_with --extraction "$F"

F="$(ex ipam-driver '/^    ipam:$/a\
      driver: custom')"
assert_red "an ipam driver on the egress network is refused" --contains "network egress ipam must set only config (found: driver)" -- guard_with --extraction "$F"
F="$(ex ipam-gateway 's/^        - subnet: 10\.250\.17\.0\/28$/        - subnet: 10.250.17.0\/28\
          gateway: 10.250.17.1/')"
assert_red "an ipam gateway on the egress network is refused" --contains "network egress ipam config must set only subnet (found: gateway)" -- guard_with --extraction "$F"

# ── H3: logging stays on the host's own driver; the image repository is pinned ──
for drv in syslog gelf fluentd local; do
  F="$(ex "log-$drv" "$WK s/^      driver: json-file\$/      driver: $drv/")"
  assert_red "logging driver $drv is refused" --contains "logging driver must be json-file (found: $drv)" -- guard_with --extraction "$F"
done
F="$(ex log-unset "$WK"' { /^    logging:$/,/^      driver: json-file$/c\
    logging:
}')"
assert_red "logging without a driver is refused" --contains "logging driver must be json-file" -- guard_with --extraction "$F"
F="$(ex log-no-block "$WK"' { /^    logging:$/,/^        max-file: .5.$/d; }')"
assert_red "no logging block (the daemon default) is refused" --contains "logging driver must be json-file (found: unset)" -- guard_with --extraction "$F"
F="$(ex log-option "$WK"' { /^        max-file: .5.$/a\
        tag: x
}')"
assert_red "a logging option outside the shipped keys is refused" --contains "logging option tag is not in the reviewed list" -- guard_with --extraction "$F"
F="$(ex log-syslog-addr "$WK"' { s/^      driver: json-file$/      driver: syslog/; /^        max-file: .5.$/a\
        syslog-address: tcp://203.0.113.9:514
}')"
assert_red "a syslog driver with a remote address is refused" --contains "logging driver must be json-file (found: syslog)" -- guard_with --extraction "$F"

for img in 'docker.io\/evil\/api' 'ghcr.io\/yaremenko-maksym\/other' 'ghcr.io\/yaremenko-maksym\/cheekycheeseit-crm-api-evil'; do
  F="$(ex "img-$(echo "$img" | tr -dc 'a-z')" "s/image: ghcr.io\\/yaremenko-maksym\\/cheekycheeseit-crm-api:/image: $img:/")"
  assert_red "image repository ${img//\\/} is refused" --contains "image repository must be ghcr.io/yaremenko-maksym/cheekycheeseit-crm-api" -- guard_with --extraction "$F"
done
F="$(ex img-digest 's/cheekycheeseit-crm-api:\${EXTRACTION_WORKER_IMAGE_TAG:?pin the worker image tag}/cheekycheeseit-crm-api@sha256:0000000000000000000000000000000000000000000000000000000000000000/')"
assert_red "an image pinned by digest alone drops the owner's tag pin, and only that is refused" --contains "an unset EXTRACTION_WORKER_IMAGE_TAG must make compose refuse" --not-contains "image repository" -- guard_with --extraction "$F"
# J7: the digest case proper is green: tag pin plus digest, right repository.
F="$(ex img-tag-digest 's/\(\${EXTRACTION_WORKER_IMAGE_TAG:?pin the worker image tag}\)/\1@sha256:0000000000000000000000000000000000000000000000000000000000000000/')"
assert_green "the tag pin plus a digest of the right repository passes" --contains "isolation OK" -- guard_with --extraction "$F"

# ── H4 + H5: env_file in long syntax ──
F="$(ex envfile-long 's/^      - .env.extraction-worker$/      - path: .env.extraction-worker/')"
assert_green "the long-syntax env_file of the right path passes" --contains "isolation OK" -- guard_with --extraction "$F"

F="$(ex envfile-long-other 's/^      - .env.extraction-worker$/      - path: .env.production/')"
assert_red "a long-syntax env_file of another path is refused" --contains "env_file must be exactly .env.extraction-worker (found: .env.production)" -- guard_with --extraction "$F"

F="$(ex envfile-optional 's/^      - .env.extraction-worker$/      - path: .env.extraction-worker\
        required: false/')"
assert_red "an optional (required: false) env_file is refused" --contains "env_file must be a plain path (found: required: false)" -- guard_with --extraction "$F"

F="$(ex envfile-raw 's/^      - .env.extraction-worker$/      - path: .env.extraction-worker\
        format: raw/')"
assert_red "an env_file with a format is refused" --contains "env_file must be a plain path (found: format: raw)" -- guard_with --extraction "$F"

F="$(ex envfile-both 's/^      - .env.extraction-worker$/      - path: .env.extraction-worker\
        required: false\
        format: raw/')"
assert_red "an optional env_file with a format is refused" --contains "env_file must be a plain path" -- guard_with --extraction "$F"

# ── H5: bypass shapes the guard catches, pinned so a rewrite cannot lose them ──
# A merge key brings in a refused key the worker never spells out; the anchor sits in a top-level
# x- key, so the worker-side error proves the merge was resolved.
F="$(ex yaml-merge -e "${WORKER}a\\
    <<: *hardening" -e '1i\
x-hardening: &hardening\
  devices: ["/dev/sda:/dev/sda"]')"
assert_red "a merge key adding a refused key is refused on the worker" --contains "extraction-worker must not set devices: not in the reviewed key allow-list" -- guard_with --extraction "$F"
assert_red "the anchor's top-level x- key is refused as well" --contains "must not declare top-level x-hardening" -- guard_with --extraction "$F"

F="$(ex extends-same-file -e "${WORKER}a\\
    extends:\\
      service: base" -e '/^volumes:$/i\
  base:\
    image: busybox\
    devices: ["/dev/sda:/dev/sda"]\
')"
assert_red "same-file extends adding a refused key is refused on the worker" --contains "extraction-worker must not set devices: not in the reviewed key allow-list" -- guard_with --extraction "$F"
assert_red "the extended service itself is an unexpected service" --contains "unexpected service base" -- guard_with --extraction "$F"

mkdir -p "$TMP/inc"
printf 'secrets:\n  hostkey:\n    file: /etc/shadow\n' > "$TMP/inc/inc.yml"
F="$(ex include-secrets "1i\\
include:\\
  - $TMP/inc/inc.yml")"
assert_red "an included file with a top-level secrets block is refused" --contains "must not declare top-level secrets" -- guard_with --extraction "$F"

F="$(ex top-level-x '$a\
x-extra: {}')"
assert_red "a top-level x- key is refused" --contains "must not declare top-level x-extra" -- guard_with --extraction "$F"

# ── J1: per-network attachment keys: entry carries aliases only, egress nothing ──
i=0
while IFS= read -r kv; do
  i=$((i + 1))
  k="${kv%%:*}"
  F="$(ex "att-egress-$i-$k" "s/^      egress: {}\$/      egress:\\
        $kv/")"
  assert_red "attachment key $k on the egress network is refused" --contains "extraction-worker must set nothing on network egress (found: $k)" -- guard_with --extraction "$F"
  F="$(ex "att-entry-$i-$k" "/^        aliases: \\[crm-extraction-worker\\]\$/a\\
        $kv")"
  assert_red "attachment key $k on the entry network is refused" --contains "extraction-worker must set only aliases on network entry (found: $k)" -- guard_with --extraction "$F"
done <<'ATT'
ipv4_address: 10.250.17.5
mac_address: 02:42:0a:fa:11:05
driver_opts: {com.docker.network.endpoint.sysctls: 'net.ipv4.conf.IFNAME.route_localnet=1'}
link_local_ips: [169.254.10.10]
interface_name: eth9
priority: 100
gw_priority: 100
ATT

# ── J2: the entry network keeps the shipped ipam, which is none ──
F="$(ex entry-ipam-subnet '/^    internal: true$/a\
    ipam:\
      config:\
        - subnet: 10.250.18.0/28')"
assert_red "an ipam subnet on the entry network is refused" --contains "network entry must set no ipam, as shipped (found: config)" -- guard_with --extraction "$F"
F="$(ex entry-ipam-driver '/^    internal: true$/a\
    ipam:\
      driver: default')"
assert_red "an ipam driver on the entry network is refused" --contains "network entry must set no ipam, as shipped (found: driver)" -- guard_with --extraction "$F"

# ── J5: compose drops ipam.options from the resolved config; the raw one keeps them ──
F="$(ex egress-ipam-options '/^        - subnet: 10\.250\.17\.0\/28$/a\
      options:\
        foo: bar')"
assert_red "ipam options on the egress network are refused" --contains "network egress ipam must set only config (found: options)" -- guard_with --extraction "$F"
F="$(ex entry-ipam-options '/^    internal: true$/a\
    ipam:\
      options:\
        foo: bar')"
assert_red "ipam options on the entry network are refused" --contains "network entry must set no ipam, as shipped (found: options)" -- guard_with --extraction "$F"

# ── J3: long-syntax env_file: path and required only; required absent or the boolean true ──
F="$(ex envfile-required-true 's/^      - .env.extraction-worker$/      - path: .env.extraction-worker\
        required: true/')"
assert_green "a long-syntax env_file with required: true passes" --contains "isolation OK" -- guard_with --extraction "$F"
F="$(ex envfile-required-str 's/^      - .env.extraction-worker$/      - path: .env.extraction-worker\
        required: "false"/')"
assert_red "an env_file with required: \"false\" (a string) is refused" --contains 'env_file must be a plain path (found: required: "false")' -- guard_with --extraction "$F"
F="$(ex envfile-required-strtrue 's/^      - .env.extraction-worker$/      - path: .env.extraction-worker\
        required: "true"/')"
assert_red "an env_file with required: \"true\" (a string, not the boolean) is refused" --contains 'env_file must be a plain path (found: required: "true")' -- guard_with --extraction "$F"
F="$(ex envfile-required-var 's/^      - .env.extraction-worker$/      - path: .env.extraction-worker\
        required: ${CRM_GUARD_T_OPT:-false}/')"
assert_red "an env_file with required: \${CRM_GUARD_T_OPT:-false} is refused" --contains 'env_file must be a plain path (found: required: "${CRM_GUARD_T_OPT:-false}")' -- guard_with --extraction "$F"

# ── J4: no value the host env decides at up; only the image tag pin may be a variable ──
while IFS='|' read -r name sedexpr path; do
  F="$(ex "dollar-$name" "$WK $sedexpr")"
  assert_red "a variable in $path is refused" --contains "$path must hold no variable: the host env would decide it at up" -- guard_with --extraction "$F"
done <<'DOLLAR'
log-driver|s/^      driver: json-file$/      driver: ${CRM_GUARD_T_LOG:-json-file}/|extraction-worker.logging.driver
mem|s/^    mem_limit: 512m$/    mem_limit: ${CRM_GUARD_T_MEM:-512m}/|extraction-worker.mem_limit
env|s/^      NODE_ENV: production$/      NODE_ENV: ${CRM_GUARD_T_NODE_ENV:-production}/|extraction-worker.environment.NODE_ENV
user|s/^    user: node$/    user: ${CRM_GUARD_T_USER:-node}/|extraction-worker.user
DOLLAR
F="$(ex dollar-repo 's/image: ghcr.io\/yaremenko-maksym\/cheekycheeseit-crm-api:/image: ${CRM_GUARD_T_REPO:-ghcr.io\/yaremenko-maksym\/cheekycheeseit-crm-api}:/')"
assert_red "a variable in the image repository is refused" --contains "extraction-worker.image must hold no variable" -- guard_with --extraction "$F"
F="$(ex dollar-tag-nested 's/\${EXTRACTION_WORKER_IMAGE_TAG:?pin the worker image tag}/${EXTRACTION_WORKER_IMAGE_TAG:?${CRM_GUARD_T_TAG}}/')"
assert_red "a second variable nested in the image tag pin is refused" --contains "extraction-worker.image must hold no variable" -- guard_with --extraction "$F"
F="$(ex dollar-net-driver '/^  egress:$/,$ s/^    driver: bridge$/    driver: ${CRM_GUARD_T_NET:-bridge}/')"
assert_red "a variable in a network definition is refused" --contains "networks.egress.driver must hold no variable" -- guard_with --extraction "$F"
F="$(ex dollar-subnet 's/^        - subnet: 10\.250\.17\.0\/28$/        - subnet: ${CRM_GUARD_T_SUBNET:-10.250.17.0\/28}/')"
assert_red "a variable in the egress subnet is refused" --contains "networks.egress.ipam.config.0.subnet must hold no variable" -- guard_with --extraction "$F"
F="$(ex dollar-volume 's/^  worker_state: {}$/  worker_state:\
    name: ${CRM_GUARD_T_VOL:-crm-extraction_worker_state}/')"
assert_red "a variable in the state volume definition is refused" --contains "volumes.worker_state.name must hold no variable" -- guard_with --extraction "$F"

# ── R5-1: no worker environment entry without a value (the host env would decide it at up) ──
F="$(ex env-map-null-db 's/^      NODE_ENV: production$/&\
      DATABASE_URL:/')"
assert_red "a map entry with no value (DATABASE_URL:) is refused" --contains "extraction-worker.environment.DATABASE_URL must carry a value" -- guard_with --extraction "$F"
F="$(ex env-map-null-other 's/^      NODE_ENV: production$/&\
      LOG_LEVEL:/')"
assert_red "a map entry with no value, any key (LOG_LEVEL:), is refused" --contains "extraction-worker.environment.LOG_LEVEL must carry a value" -- guard_with --extraction "$F"
F="$(ex env-list-null-db '/^    environment:$/,/^    volumes:$/c\
    environment:\
      - DATABASE_URL\
      - NODE_ENV=production\
      - EXTRACTION_WORKER_HOST=0.0.0.0\
      - EXTRACTION_WORKER_PORT=3100\
      - EXTRACTION_ROUTER_STATE_FILE=/var/lib/extraction-worker/router-state.json\
    volumes:')"
assert_red "a list item with no = (- DATABASE_URL) is refused" --contains "extraction-worker.environment.DATABASE_URL must carry a value" -- guard_with --extraction "$F"

# ── R5-2: the top-level project name holds no variable either ──
F="$(ex top-name-var 's/^name: crm-extraction$/name: ${CRM_GUARD_T_NAME:-crm-extraction}/')"
assert_red "a variable in the top-level name is refused" --contains "name must hold no variable" -- guard_with --extraction "$F"

# ── R6-1: the top-level name is read from the raw (no-interpolate) config, not a text regex ──
F="$(ex top-name-quoted 's/^name: crm-extraction$/"name": ${CRM_GUARD_T_NAME:-crm-extraction}/')"
assert_red "a variable under a quoted top-level name key is refused" --contains "name must hold no variable" -- guard_with --extraction "$F"
F="$(ex top-name-space 's/^name: crm-extraction$/name : ${CRM_GUARD_T_NAME:-crm-extraction}/')"
assert_red "a space before the top-level name colon does not hide a variable" --contains "name must hold no variable" -- guard_with --extraction "$F"
F="$(ex top-name-next-line 's/^name: crm-extraction$/name:\
  ${CRM_GUARD_T_NAME:-crm-extraction}/')"
assert_red "a variable on the line after the top-level name key is refused" --contains "name must hold no variable" -- guard_with --extraction "$F"
F="$(ex top-name-comment 's/^name: crm-extraction$/name: crm-extraction # ${CRM_GUARD_T_NAME:-x}/')"
assert_green "a variable only in a trailing comment on the name line is not refused" --contains "isolation OK" -- guard_with --extraction "$F"
assert_green "the shipped extraction file passes the name check" --contains "isolation OK" -- guard_with

# ── R7-1 (+ SR-M-12): the top-level name is read as written, not normalised by compose ──
F="$(ex top-name-dollar 's/^name: crm-extraction$/name: $crm-extraction/')"
assert_red "a bare \$ before the top-level name is refused" --contains "must read crm-extraction as written" -- guard_with --extraction "$F"
F="$(ex top-name-double-dollar 's/^name: crm-extraction$/name: $$crm-extraction/')"
assert_red "an escaped \$\$ before the top-level name is refused" --contains "must read crm-extraction as written" -- guard_with --extraction "$F"
F="$(ex top-name-empty-braces 's/^name: crm-extraction$/name: ${}crm-extraction/')"
assert_red "an empty \${} before the top-level name is refused (parse failure or name check)" -- guard_with --extraction "$F"
F="$(ex top-name-missing '/^name: crm-extraction$/d')"
assert_red "a file with no top-level name key is refused" --contains "must read crm-extraction as written" -- guard_with --extraction "$F"
F="$(ex top-name-default-sub 's/^name: crm-extraction$/name: ${__:-crm-extraction}/')"
assert_red "a defaulted variable whose default is the name is refused (SR-M-12)" --contains "must read crm-extraction as written" -- guard_with --extraction "$F"
F="$(ex top-name-underscore-default 's/^name: crm-extraction$/name: ${_-crm-extraction}/')"
assert_red "a leading-underscore default of the name is refused on purpose (SR-M-12)" --contains "must read crm-extraction as written" -- guard_with --extraction "$F"

# ── the composed deploy configuration ──
F="$(mutate "$PROD" gains-worker '/^  # ── nginx (reverse-proxy/i\
  extraction-worker:\
    image: busybox\
')"
assert_red "the deploy configuration gaining the worker is refused" --contains "gained service extraction-worker" -- guard_with --prod "$F"

F="$(mutate "$PROD" gains-profile '/^  # ── nginx (reverse-proxy/i\
  llm:\
    profiles: ["model"]\
    image: busybox\
')"
assert_red "a model service behind a profile in the main file is refused" --contains "gained service llm" -- guard_with --prod "$F"

# compose drops a declared network no service uses, so api joins it too.
F="$(mutate "$PROD" external-net -e '/^networks:$/a\
  crossing:\
    external: true\
    name: some-shared-net
' -e 's/^      - frontend$/      - frontend\
      - crossing/')"
assert_red "an external network in the deploy configuration is refused" --contains "must not use external network crossing" -- guard_with --prod "$F"

# The network the old prod file declared; resolves to crm_extraction-internal.
F="$(mutate "$PROD" readds-net -e '/^networks:$/a\
  extraction-internal:\
    internal: true
' -e 's/^      - frontend$/      - frontend\
      - extraction-internal/')"
assert_red "an extraction network re-added to the prod file is refused" --contains "must not declare network extraction-internal" -- guard_with --prod "$F"

# ── the deploy paths ──
F="$(mutate "$SCRIPT" names-file '1a\
docker compose -f docker-compose.extraction.yml up -d')"
assert_red "the deploy script naming the file is refused" --contains "names the extraction project or its file" -- guard_with --script "$F"

F="$(mutate "$WORKFLOW" names-file-wf '1a\
# source: docker-compose.extraction.yml')"
assert_red "deploy.yml naming the file is refused" --contains "names the extraction project or its file" -- guard_with --workflow "$F"

F="$(mutate "$SCRIPT" names-project '1a\
docker compose -p crm-extraction ps')"
assert_red "the deploy script naming the project is refused" --contains "names the extraction project or its file" -- guard_with --script "$F"

F="$(mutate "$SCRIPT" names-container '1a\
docker restart crm-extraction-extraction-worker-1')"
assert_red "the deploy script naming the worker's container is refused" --contains "names the extraction project or its file" -- guard_with --script "$F"

# CR-H-1: the API's worker URL names the alias, and the entry network is the soft attach: both pass.
assert_green "deploy.yml writes the API's worker URL by the alias" --contains "http://crm-extraction-worker:3100" -- grep -F "'http://crm-extraction-worker:3100'" "$WORKFLOW"
F="$(mutate "$WORKFLOW" names-alias '1a\
# EXTRACTION_WORKER_URL=http://crm-extraction-worker:3100 on crm-extraction-entry')"
assert_green "deploy.yml naming the worker alias and the entry network passes" --contains "isolation OK" -- guard_with --workflow "$F"

mkdir -p "$TMP/empty" && : > "$TMP/empty/deploy-stack-on-vps.sh"
assert_red "an empty deploy script is not read as clean" --contains "nothing was checked" -- guard_with --script "$TMP/empty/deploy-stack-on-vps.sh"

assert_red "a missing deploy script is not read as clean" --contains "could not read" -- guard_with --script "$TMP/empty/absent.sh"

guard_test_summary "test-check-extraction-worker-compose.sh"

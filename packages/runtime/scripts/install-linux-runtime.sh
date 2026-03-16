#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_package_root=$(CDPATH= cd -- "${script_dir}/.." && pwd)
prefix="/opt/remote-agent-runtime"
node_bin="node"
server_url=""
bootstrap_token=""
host_id=""
host_name=""
platform="linux"

usage() {
  cat <<'EOF'
Usage:
  install-linux-runtime.sh --server-url <url> --bootstrap-token <token> --host-id <id> [options]

Options:
  --prefix <path>                Install prefix. Default: /opt/remote-agent-runtime
  --server-url <url>             Control plane base URL.
  --bootstrap-token <token>      Bootstrap token for /api/hosts enrollment.
  --host-id <id>                 Stable host identifier used for idempotent upserts.
  --host-name <name>             Human-readable host name. Default: current hostname
  --platform <name>              Platform label. Default: linux
  --node-bin <path>              Node executable to use. Default: node
  --source-package-root <path>   Runtime package root containing dist/ and package.json
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      prefix="$2"
      shift 2
      ;;
    --server-url)
      server_url="$2"
      shift 2
      ;;
    --bootstrap-token)
      bootstrap_token="$2"
      shift 2
      ;;
    --host-id)
      host_id="$2"
      shift 2
      ;;
    --host-name)
      host_name="$2"
      shift 2
      ;;
    --platform)
      platform="$2"
      shift 2
      ;;
    --node-bin)
      node_bin="$2"
      shift 2
      ;;
    --source-package-root)
      source_package_root="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "${server_url}" || -z "${bootstrap_token}" || -z "${host_id}" ]]; then
  printf 'Missing required install options.\n' >&2
  usage >&2
  exit 1
fi

if [[ -z "${host_name}" ]]; then
  host_name=$(hostname 2>/dev/null || printf '%s' "${host_id}")
fi

dist_dir="${source_package_root}/dist"
package_json="${source_package_root}/package.json"
runtime_home="${prefix}/lib/runtime"
bin_dir="${prefix}/bin"
etc_dir="${prefix}/etc"
var_dir="${prefix}/var"
env_file="${etc_dir}/remote-agent-runtime.env"
launcher="${bin_dir}/remote-agent-runtime"
enroll_launcher="${bin_dir}/remote-agent-runtime-enroll"
status_launcher="${bin_dir}/remote-agent-runtime-status"
state_file="${var_dir}/runtime-state.json"

if [[ ! -d "${dist_dir}" ]]; then
  printf 'Expected built runtime files at %s. Run "pnpm --filter @remote-agent-server/runtime... build" first.\n' "${dist_dir}" >&2
  exit 1
fi

mkdir -p "${runtime_home}" "${bin_dir}" "${etc_dir}" "${var_dir}"
rm -rf "${runtime_home}/dist"
cp -R "${dist_dir}" "${runtime_home}/dist"
cp "${package_json}" "${runtime_home}/package.json"

{
  printf 'export RAS_SERVER_URL=%q\n' "${server_url%/}"
  printf 'export RAS_BOOTSTRAP_TOKEN=%q\n' "${bootstrap_token}"
  printf 'export RAS_HOST_ID=%q\n' "${host_id}"
  printf 'export RAS_HOST_NAME=%q\n' "${host_name}"
  printf 'export RAS_PLATFORM=%q\n' "${platform}"
  printf 'export RAS_STATUS=%q\n' "online"
  printf 'export RAS_HEALTH=%q\n' "healthy"
  printf 'export RAS_CONNECTIVITY=%q\n' "connected"
  printf 'export RAS_STATE_FILE=%q\n' "${state_file}"
} >"${env_file}"

cat >"${launcher}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec $(printf '%q' "${node_bin}") $(printf '%q' "${runtime_home}/dist/cli.js") "\$@"
EOF

cat >"${enroll_launcher}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
source $(printf '%q' "${env_file}")
exec $(printf '%q' "${launcher}") enroll "\$@"
EOF

cat >"${status_launcher}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
source $(printf '%q' "${env_file}")
exec $(printf '%q' "${launcher}") status "\$@"
EOF

chmod 755 "${launcher}" "${enroll_launcher}" "${status_launcher}"

printf 'Installed RemoteAgentServer runtime to %s\n' "${prefix}"
printf 'Enroll with: %s\n' "${enroll_launcher}"
printf 'Inspect status with: %s\n' "${status_launcher}"

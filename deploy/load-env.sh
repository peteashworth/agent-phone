# Loads /etc/agent-phone.env the way systemd's EnvironmentFile reads it (the service's view), WITHOUT running it as
# shell: values may contain spaces/quotes/$ (VOICEMAIL_LINE, CODE_PHRASE...). Plain `source` breaks on those.
# Usage (bash):  source /opt/agent-phone/deploy/load-env.sh [file]
# Skips blank and #/; lines; strips one pair of surrounding quotes; a later line for the same KEY wins (like systemd).
# Never prints values, only line numbers of lines it can't read.
__ap_env_file=${1:-/etc/agent-phone.env}
__ap_n=0
while IFS= read -r __ap_line || [ -n "$__ap_line" ]; do
  __ap_n=$((__ap_n + 1))
  __ap_line=${__ap_line%$'\r'}
  __ap_trim=${__ap_line#"${__ap_line%%[![:space:]]*}"}
  case "$__ap_trim" in ''|'#'*|';'*) continue ;; esac
  __ap_key=${__ap_trim%%=*}
  __ap_key=${__ap_key%"${__ap_key##*[![:space:]]}"}
  if [ "$__ap_key" = "$__ap_trim" ] || ! [[ "$__ap_key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "load-env: $__ap_env_file line $__ap_n is not KEY=value, skipped (systemd skips it too)" >&2
    continue
  fi
  __ap_val=${__ap_trim#*=}
  __ap_val=${__ap_val#"${__ap_val%%[![:space:]]*}"}
  __ap_val=${__ap_val%"${__ap_val##*[![:space:]]}"}
  if [[ ${#__ap_val} -ge 2 && ( ( $__ap_val == \"*\" ) || ( $__ap_val == \'*\' ) ) ]]; then
    __ap_val=${__ap_val:1:${#__ap_val}-2}
  fi
  export "$__ap_key=$__ap_val"
done < "$__ap_env_file"
unset __ap_env_file __ap_n __ap_line __ap_trim __ap_key __ap_val

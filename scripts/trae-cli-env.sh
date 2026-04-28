#!/usr/bin/env sh

pat="${1:-${PAT:-}}"
if [ -z "$pat" ]; then
  printf 'usage: PAT=<token>; source /path/to/trae-cli-env.sh\n' >&2
  return 2 2>/dev/null || exit 2
fi

config_dir="$HOME/.trae"
config_file="$config_dir/traecli.yaml"
legacy_config_file="$config_dir/trae_cli.yaml"

if [ ! -f "$config_file" ]; then
  mkdir -p "$config_dir"
  cat > "$config_file" <<'EOF'
allowed_tools:
  - Bash(traecli:*)
  - Bash(dwsp:*)
model:
  name: GLM-5.1
trae_login_base_url: https://console.enterprise.trae.cn
EOF
fi

if [ ! -f "$legacy_config_file" ]; then
  mkdir -p "$config_dir"
  cat > "$legacy_config_file" <<'EOF'
model:
    name: GLM-5.1
EOF
fi

trae_bin_dir=""
for candidate in \
  /usr/local/bin \
  "$HOME/.local/bin"
do
  if [ -x "$candidate/trae-cli" ] || [ -x "$candidate/traecli" ] || [ -x "$candidate/trae" ]; then
    trae_bin_dir="$candidate"
    break
  fi
done

export TRAECLI_PERSONAL_ACCESS_TOKEN="$pat"
export SEC_TOKEN_PATH="$HOME/.cache/trae-cli/sec-token"

if [ -n "$trae_bin_dir" ]; then
  case ":$PATH:" in
    *":$trae_bin_dir:"*) ;;
    *) export PATH="$trae_bin_dir:$PATH" ;;
  esac
fi

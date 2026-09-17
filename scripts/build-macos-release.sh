#!/usr/bin/env bash
#
# build-macos-release.sh — Signed + notarized + stapled macOS release build.
#
# This script contains NO secrets. It only validates that the required
# environment variables are present, then hands off to `pnpm tauri build`,
# which performs code-signing + notarization + stapling itself based on the
# env vars described below.
#
# One-time Apple-side prerequisites (see docs/RELEASE-macos.md):
#   - "Developer ID Application: NAME (TEAMID)" cert installed in the login keychain
#   - EITHER an app-specific password OR an App Store Connect API key
#   - your Apple Team ID
#
# Required env vars
# ----------------
# Signing (always required):
#   APPLE_SIGNING_IDENTITY   e.g. "Developer ID Application: Jane Doe (AB12CD34EF)"
#
# Notarization — provide EXACTLY ONE of the two methods:
#
#   Method A — Apple ID + app-specific password:
#     APPLE_ID                 your Apple ID email
#     APPLE_PASSWORD           app-specific password (NOT your Apple ID password)
#     APPLE_TEAM_ID            your 10-char Team ID
#
#   Method B — App Store Connect API key:
#     APPLE_API_KEY            the key ID (e.g. AB12CD34EF)
#     APPLE_API_ISSUER         the issuer UUID
#     APPLE_API_KEY_PATH       path to the .p8 private key file
#
set -euo pipefail

# Resolve repo root from this script's location so it works from any cwd.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

err() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; }
info() { printf '\033[32m▸ %s\033[0m\n' "$1"; }

# ---------------------------------------------------------------- 인자
ARG_UPDATER_KEY=""
ARG_ENV_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --updater-key) ARG_UPDATER_KEY="${2:?--updater-key 에 경로가 필요합니다}"; shift 2 ;;
    --env-file)    ARG_ENV_FILE="${2:?--env-file 에 경로가 필요합니다}"; shift 2 ;;
    -h|--help)
      cat <<'USAGE'
사용법: build-macos-release.sh [옵션]

  --updater-key <경로>   업데이터 서명 키 (기본: ~/.tauri/<package.json name>.key)
  --env-file <경로>      애플 자격 파일 (기본: ~/.apple-signing.env)

서명·공증한 universal .app/.dmg 를 만든다. 자격은 환경변수로 넘겨도 된다.
USAGE
      exit 0 ;;
    *) printf '알 수 없는 옵션: %s\n' "$1" >&2; exit 1 ;;
  esac
done

# 계정 공통 자격을 먼저 읽어들인다 (없으면 환경변수로 넘어온 값을 쓴다).
# 앱 암호는 애플 ID 에 속하므로 프로젝트마다 따로 만들 필요가 없다.
_env_file="${ARG_ENV_FILE/#\~/${HOME}}"
_env_file="${_env_file:-${HOME}/.apple-signing.env}"
if [[ -z "${APPLE_ID:-}" && -f "${_env_file}" ]]; then
  # shellcheck disable=SC1091
  source "${_env_file}"
  info "자격 로드: ${_env_file/#${HOME}/\~}"
fi

# 업데이터 서명 키.
# 우선순위: --updater-key 인자 > TAURI_SIGNING_PRIVATE_KEY(_PATH) > ~/.tauri/<name>.key
# Tauri v2 는 키 "내용"을 TAURI_SIGNING_PRIVATE_KEY 로 받는다 (경로 변수는 읽지 않는다).
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  if [[ -n "${ARG_UPDATER_KEY}" ]]; then
    _updater_key="${ARG_UPDATER_KEY/#\~/${HOME}}"
  elif [[ -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]]; then
    _updater_key="${TAURI_SIGNING_PRIVATE_KEY_PATH}"
  else
    _proj="$(node -p "require('${REPO_ROOT}/package.json').name" 2>/dev/null || basename "${REPO_ROOT}")"
    _updater_key="${HOME}/.tauri/${_proj}.key"
    info "업데이터 키를 추론했습니다 (명시하려면 --updater-key <경로>)"
  fi
  if [[ -f "${_updater_key}" ]]; then
    TAURI_SIGNING_PRIVATE_KEY="$(cat "${_updater_key}")"
    export TAURI_SIGNING_PRIVATE_KEY
    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
    info "업데이터 키: ${_updater_key/#${HOME}/\~}"
  else
    err "업데이터 키가 없습니다: ${_updater_key/#${HOME}/\~}"
    err "만들려면: pnpm tauri signer generate -w \"${_updater_key}\" --password \"\""
    err "지금은 자동 업데이트 없이 빌드합니다."
  fi
fi

missing=()

# --- Signing identity (always required) ---
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  missing+=("APPLE_SIGNING_IDENTITY  (e.g. \"Developer ID Application: NAME (TEAMID)\")")
fi

# --- Notarization: detect which method (if any) is configured ---
have_method_a=false
have_method_b=false
[[ -n "${APPLE_ID:-}" || -n "${APPLE_PASSWORD:-}" || -n "${APPLE_TEAM_ID:-}" ]] && have_method_a=true
[[ -n "${APPLE_API_KEY:-}" || -n "${APPLE_API_ISSUER:-}" || -n "${APPLE_API_KEY_PATH:-}" ]] && have_method_b=true

notarization_method=""

if [[ "${have_method_a}" == true && "${have_method_b}" == true ]]; then
  err "Both notarization methods are partially set — provide EXACTLY ONE."
  err "  Method A: APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID"
  err "  Method B: APPLE_API_KEY + APPLE_API_ISSUER + APPLE_API_KEY_PATH"
  exit 1
elif [[ "${have_method_a}" == true ]]; then
  notarization_method="A (Apple ID + app-specific password)"
  [[ -z "${APPLE_ID:-}" ]]      && missing+=("APPLE_ID")
  [[ -z "${APPLE_PASSWORD:-}" ]] && missing+=("APPLE_PASSWORD  (app-specific password)")
  [[ -z "${APPLE_TEAM_ID:-}" ]]  && missing+=("APPLE_TEAM_ID")
elif [[ "${have_method_b}" == true ]]; then
  notarization_method="B (App Store Connect API key)"
  [[ -z "${APPLE_API_KEY:-}" ]]       && missing+=("APPLE_API_KEY")
  [[ -z "${APPLE_API_ISSUER:-}" ]]    && missing+=("APPLE_API_ISSUER")
  [[ -z "${APPLE_API_KEY_PATH:-}" ]]  && missing+=("APPLE_API_KEY_PATH")
  if [[ -n "${APPLE_API_KEY_PATH:-}" && ! -f "${APPLE_API_KEY_PATH}" ]]; then
    missing+=("APPLE_API_KEY_PATH points to a non-existent file: ${APPLE_API_KEY_PATH}")
  fi
else
  err "No notarization credentials detected. Provide EXACTLY ONE method:"
  err "  Method A: APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID"
  err "  Method B: APPLE_API_KEY + APPLE_API_ISSUER + APPLE_API_KEY_PATH"
  notarization_method="<none>"
fi

if (( ${#missing[@]} > 0 )) || [[ "${notarization_method}" == "<none>" ]]; then
  err "Cannot start a signed release build. Detected notarization method: ${notarization_method:-<none>}"
  if (( ${#missing[@]} > 0 )); then
    err "Missing / invalid required environment variables:"
    for m in "${missing[@]}"; do
      printf '    - %s\n' "$m" >&2
    done
  fi
  err "See docs/RELEASE-macos.md for setup. Aborting WITHOUT building."
  exit 1
fi

info "Signing identity: present (APPLE_SIGNING_IDENTITY)"
info "Notarization method: ${notarization_method}"
info "Building signed + notarized + stapled macOS bundle (.app + .dmg)…"

cd -- "${REPO_ROOT}"

# --- Path-privacy: strip the build machine's absolute paths from the binary ---
# Rust embeds source paths in panic/assert strings; for a publicly distributed
# binary those would leak the builder's username (e.g.
# `/Users/<user>/.cargo/registry/...`). Remap $HOME (covers ~/.cargo, ~/.rustup,
# and the checkout) and $CARGO_HOME to non-identifying prefixes. Computed at
# build time so it stays correct on any build machine. rustc's std is already
# shipped pre-remapped to `/rustc/<hash>/`.
_cargo_home="${CARGO_HOME:-${HOME}/.cargo}"
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=${_cargo_home}=/cargo --remap-path-prefix=${HOME}=/build"
info "Path remapping enabled (RUSTFLAGS --remap-path-prefix)"

# Universal build (Intel x86_64 + Apple Silicon arm64) so the single public
# download runs on ALL Macs. This app bundles no nested binaries, so Tauri's
# own signing covers everything in the bundle.
pnpm tauri build --target universal-apple-darwin --bundles app,dmg

# Tauri v2 notarizes + staples the .app, but NOT the .dmg wrapper (it only signs
# it). A downloaded .dmg must itself be notarized + stapled or Gatekeeper rejects
# it ("Unnotarized Developer ID") on mount. So notarize + staple the dmg here.
# The universal build emits under the target triple's bundle dir.
DMG="$(ls -t "${REPO_ROOT}"/src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg 2>/dev/null | head -1)"
if [[ -z "${DMG}" ]]; then
  err "No .dmg was produced under src-tauri/target/release/bundle/dmg/"
  exit 1
fi

info "Notarizing the dmg wrapper: ${DMG##*/}"
if [[ "${notarization_method}" == A* ]]; then
  xcrun notarytool submit "${DMG}" \
    --apple-id "${APPLE_ID}" --password "${APPLE_PASSWORD}" --team-id "${APPLE_TEAM_ID}" --wait
else
  xcrun notarytool submit "${DMG}" \
    --key "${APPLE_API_KEY_PATH}" --key-id "${APPLE_API_KEY}" --issuer "${APPLE_API_ISSUER}" --wait
fi
xcrun stapler staple "${DMG}"
xcrun stapler validate "${DMG}"
# Final Gatekeeper assessment (informational; non-fatal).
spctl -a -vvv -t install "${DMG}" || true
info "Done: signed + notarized + stapled dmg → ${DMG}"

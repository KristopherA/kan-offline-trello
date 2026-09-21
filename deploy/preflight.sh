#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

[[ -f .env ]] || fail "Missing .env; copy .env.kan.example to .env first."

for variable in POSTGRES_PASSWORD BETTER_AUTH_SECRET; do
  value="$(sed -n "s/^${variable}=//p" .env | tail -n 1)"
  [[ -n "$value" ]] || fail "$variable is missing or empty in .env."
  [[ "$value" != REPLACE_ME* ]] || fail "$variable still contains its placeholder."
done

hostname="$(sed -n 's/^KAN_HOSTNAME=//p' .env | tail -n 1)"
[[ -n "$hostname" ]] || fail "KAN_HOSTNAME is missing or empty in .env."
[[ "$hostname" != "kan.example.com" ]] || fail "KAN_HOSTNAME still contains the example hostname."
[[ "$hostname" != *"://"* && "$hostname" != */* ]] \
  || fail "KAN_HOSTNAME must contain only a DNS hostname, without a URL scheme or path."

cert_file="deploy/tls/tls.crt"
key_file="deploy/tls/tls.key"

[[ -s "$cert_file" ]] || fail "Missing TLS certificate: $cert_file"
[[ -s "$key_file" ]] || fail "Missing TLS private key: $key_file"
openssl x509 -in "$cert_file" -noout -checkend 86400 >/dev/null 2>&1 \
  || fail "The TLS certificate is invalid, expired, or expires within 24 hours."
openssl x509 -in "$cert_file" -noout -checkhost "$hostname" >/dev/null 2>&1 \
  || fail "The TLS certificate does not cover $hostname."
openssl pkey -in "$key_file" -noout -passin pass: >/dev/null 2>&1 \
  || fail "The TLS private key is invalid or encrypted; Nginx needs an unencrypted key."

cert_pubkey="$(openssl x509 -in "$cert_file" -pubkey -noout | openssl pkey -pubin -outform DER 2>/dev/null | openssl sha256)"
key_pubkey="$(openssl pkey -in "$key_file" -pubout -outform DER -passin pass: 2>/dev/null | openssl sha256)"
[[ "$cert_pubkey" == "$key_pubkey" ]] || fail "The TLS certificate and private key do not match."

docker compose config --quiet
printf 'Preflight passed for https://%s\n' "$hostname"

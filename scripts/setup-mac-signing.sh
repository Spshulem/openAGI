#!/usr/bin/env bash
# Create a self-signed local code-signing identity so OpenAGI.app keeps the
# same identity across rebuilds. Without this, every `./scripts/build-mac-app.sh`
# produces a binary with a different signature, and macOS re-prompts for
# Screen Recording / Accessibility permissions every time.
#
# Run once. After this:
#   - build-mac-app.sh auto-detects "OpenAGI Local Signing" and signs with it
#   - macOS TCC remembers your "Allow" once and stops re-asking
#
# Idempotent: safe to re-run; will skip if the cert already exists.
set -euo pipefail

CERT_NAME="OpenAGI Local Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

if security find-identity -v -p codesigning | grep -q "$CERT_NAME"; then
  echo "✓ '$CERT_NAME' already exists in your login keychain."
  echo "  Run ./scripts/build-mac-app.sh to use it."
  exit 0
fi

echo "▶ Creating self-signed code-signing certificate '$CERT_NAME'…"

# OpenSSL config with code-signing EKU
cat > "$TMPDIR/openssl.cnf" <<EOF
[ req ]
distinguished_name = req_dn
prompt = no
req_extensions = v3_req

[ req_dn ]
CN = $CERT_NAME
O = OpenAGI

[ v3_req ]
basicConstraints = CA:false
keyUsage = digitalSignature
extendedKeyUsage = codeSigning
EOF

# Generate self-signed cert + key
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$TMPDIR/key.pem" \
  -out "$TMPDIR/cert.pem" \
  -days 3650 \
  -config "$TMPDIR/openssl.cnf" \
  -extensions v3_req >/dev/null 2>&1

# Bundle into PKCS#12. Apple's `security import` only reads the legacy
# (PBE-SHA1-3DES + PBE-SHA1-RC2-40) format; OpenSSL 3 defaults to AES which
# fails with "MAC verification failed". The -legacy flag forces the old format.
PKCS12_FLAGS=""
if openssl pkcs12 -help 2>&1 | grep -q -- "-legacy"; then
  PKCS12_FLAGS="-legacy"
fi
openssl pkcs12 -export $PKCS12_FLAGS \
  -inkey "$TMPDIR/key.pem" \
  -in "$TMPDIR/cert.pem" \
  -name "$CERT_NAME" \
  -out "$TMPDIR/bundle.p12" \
  -passout pass:openagi 2>&1 | grep -v "Warning" || true

# Import into login keychain, allow codesign to use it without prompting
security import "$TMPDIR/bundle.p12" \
  -k "$KEYCHAIN" \
  -P openagi \
  -T /usr/bin/codesign \
  -T /usr/bin/security >/dev/null

# Mark as trusted for code signing (avoids prompts during build)
# Trust settings on a self-signed cert require admin; we skip if it fails.
security set-key-partition-list -S "apple-tool:,apple:,codesign:" \
  -s -k "$(security default-keychain | tr -d ' "' | sed 's/keychain-db$//')${USER}" \
  "$KEYCHAIN" >/dev/null 2>&1 || true

echo
if security find-identity -v -p codesigning | grep -q "$CERT_NAME"; then
  echo "✓ Created '$CERT_NAME' and imported into your login keychain."
  echo
  echo "Next steps:"
  echo "  1. ./scripts/build-mac-app.sh   (will auto-sign with this cert)"
  echo "  2. Open the rebuilt app and grant Screen Recording / Accessibility once"
  echo "  3. macOS will remember the grant across future rebuilds"
  echo
  echo "If you re-rebuild and macOS still re-prompts, you may need to delete"
  echo "the existing entry under System Settings → Privacy → Screen Recording"
  echo "(remove 'OpenAGI'), then grant once with the freshly-signed build."
else
  echo "✗ Import failed. Manual fallback: open Keychain Access →"
  echo "  Certificate Assistant → Create a Certificate → Name '$CERT_NAME',"
  echo "  Identity Type 'Self Signed Root', Certificate Type 'Code Signing'."
  exit 1
fi

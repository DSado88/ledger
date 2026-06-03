#!/bin/bash
# Pre-commit secret scan — last line of defense before a credential is committed.
# Prefers gitleaks if installed; otherwise runs a targeted regex scan over staged
# content. Install: scripts/install-hooks.sh  (or copy to .git/hooks/pre-commit)
set -euo pipefail

# 1) Block secret-bearing files from being staged at all (even via `git add -f`).
staged_files=$(git diff --cached --name-only --diff-filter=ACM)
# Block real dotenv files (.env, .env.local, .env.production, …) and review
# outputs — but allow committed templates (.env.example / .sample / .template),
# which carry only placeholders.
blocked=$(printf '%s\n' "$staged_files" \
  | grep -iE '(^|/)\.env($|\.)|\.squall/reviews/' \
  | grep -ivE '\.(example|sample|template)$' || true)
if [ -n "$blocked" ]; then
  echo "✖ pre-commit: refusing to commit secret-bearing file(s):" >&2
  printf '   %s\n' $blocked >&2
  echo "  These are gitignored for a reason. Unstage them (git restore --staged <file>)." >&2
  exit 1
fi

# 2) If gitleaks is available, let it do the heavy lifting on staged content.
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks protect --staged --redact --no-banner || {
    echo "✖ pre-commit: gitleaks found a potential secret in staged changes." >&2
    exit 1
  }
  exit 0
fi

# 3) Fallback: targeted regex scan of the staged diff for high-value Ledger secrets.
#    Patterns are tuned to real credentials, not test fixtures (short stub values pass).
diff=$(git diff --cached -U0 || true)
patterns=(
  'ops_[A-Za-z0-9_-]{30,}'                              # 1Password service-account token
  'access-(production|development)-[0-9a-f]{8}-[0-9a-f-]{27,}'  # Plaid access token (UUID)
  'PLAID_SECRET=[A-Za-z0-9]{16,}'                       # Plaid secret value
  'PLAID_CLIENT_ID=[a-f0-9]{20,}'                       # Plaid client id (real hex)
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'                  # any private key
)
hit=0
for p in "${patterns[@]}"; do
  if printf '%s' "$diff" | grep -E "^\+" | grep -qE -e "$p"; then
    echo "✖ pre-commit: staged change matches secret pattern: $p" >&2
    hit=1
  fi
done
if [ "$hit" -ne 0 ]; then
  echo "  Remove the secret or, if it is a false positive, commit with --no-verify (be sure)." >&2
  echo "  Tip: install gitleaks for stronger detection (brew install gitleaks)." >&2
  exit 1
fi
exit 0

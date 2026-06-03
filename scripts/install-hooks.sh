#!/bin/bash
# Install git hooks for this repo. Run once after cloning: bash scripts/install-hooks.sh
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
hook_dir="$repo_root/.git/hooks"
mkdir -p "$hook_dir"
cat > "$hook_dir/pre-commit" <<'EOF'
#!/bin/bash
exec "$(git rev-parse --show-toplevel)/scripts/pre-commit-secret-scan.sh"
EOF
chmod +x "$hook_dir/pre-commit"
echo "✓ Installed pre-commit secret scan → $hook_dir/pre-commit"

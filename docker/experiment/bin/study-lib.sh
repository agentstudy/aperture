# Shared paths. Session records live outside the repo, so they never appear in Source Control or
# the agent's view of the tree, and under /workspaces, so they survive a container rebuild.
repo_root() { git rev-parse --show-toplevel 2>/dev/null || pwd; }
record_dir() {
  local base=${STUDY_RECORD_BASE:-/workspaces/.study}
  mkdir -p "$base" 2>/dev/null || base=$HOME/.study
  mkdir -p "$base/$1" && echo "$base/$1"
}

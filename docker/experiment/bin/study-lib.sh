# Shared paths. Session records live outside the repo, so they never appear in Source Control or
# the agent's view of the tree, and under /workspaces, so they survive a container rebuild.
#
#   <base>/<repo>/phase           "warmup", "main" or "submitted": which part of the session is current
#   <base>/<repo>/warmup/, main/  one record per phase: session.env, tool data (transcript DB), logs
#   <base>/<repo>/.layout-done    the study logger's first-start layout ran
#   <base>/<repo>/switched        written by study-next when the main task is ready
#   <base>/<repo>/submitted       written by study-submit after a successful push and reset
#   <base>/<repo>/.submitted/<id>/  the phase records, moved there by study-submit (already pushed)
repo_root() { git rev-parse --show-toplevel 2>/dev/null || pwd; }
study_base() {
  local base=${STUDY_RECORD_BASE:-/workspaces/.study}
  mkdir -p "$base" 2>/dev/null || { base=$HOME/.study; mkdir -p "$base"; }
  echo "$base"
}
# The phase starts from the branch the codespace opened on (…-warmup → warmup) and is changed to
# main by study-next.
repo_phase() { # <repo-name>
  local f; f="$(study_base)/$1/phase"
  if [ ! -s "$f" ]; then
    mkdir -p "$(dirname "$f")"
    case "$(git -C "/workspaces/$1" branch --show-current 2>/dev/null || git branch --show-current 2>/dev/null)" in
      *-warmup) echo warmup > "$f" ;;
      *) echo main > "$f" ;;
    esac
  fi
  cat "$f"
}
record_dir() { # <repo-name>
  local d; d="$(study_base)/$1/$(repo_phase "$1")"
  mkdir -p "$d" && echo "$d"
}
# The tool's processes: bun running from /opt/tool. Anchored on the bun binary so a shell or editor
# whose command line merely mentions these paths is never matched (and killed by stop_tool).
TOOL_PROC='^([^ ]*/)?bun .*(/opt/tool/packages/opencode|src/index\.ts)'
stop_tool() {
  if pgrep -f "$TOOL_PROC" >/dev/null; then
    echo "Closing the coding assistant..."
    pkill -TERM -f "$TOOL_PROC" || true
    for _ in $(seq 20); do pgrep -f "$TOOL_PROC" >/dev/null || break; sleep 0.5; done
    pkill -KILL -f "$TOOL_PROC" 2>/dev/null || true
    sleep 1
  fi
}

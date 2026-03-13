#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# LiveKit Test Results — Export & Summary
# ═══════════════════════════════════════════════════════════════════
#
# Usage:
#   ./export-results.sh                   # Show summary of all results
#   ./export-results.sh latest            # Show only the latest result
#   ./export-results.sh csv               # Export all results as CSV
#   ./export-results.sh zip               # Package all results into a zip
#   ./export-results.sh clean             # Delete all result files
#
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"

if [ ! -d "$RESULTS_DIR" ] || [ -z "$(ls -A "$RESULTS_DIR" 2>/dev/null)" ]; then
  echo "No results found in $RESULTS_DIR"
  echo "Run ./run-tests.sh first."
  exit 0
fi

# ── Show summary of all results ──────────────────────────────────
show_summary() {
  echo ""
  echo "═══════════════════════════════════════════════════════════"
  echo "  LIVEKIT TEST RESULTS SUMMARY"
  echo "  Directory: $RESULTS_DIR"
  echo "═══════════════════════════════════════════════════════════"
  echo ""

  echo "  Available result files:"
  echo "  ────────────────────────────────────────────────────────"
  for f in "$RESULTS_DIR"/*.log; do
    [ -f "$f" ] || continue
    local fname=$(basename "$f")
    local size=$(du -h "$f" | cut -f1 | xargs)
    local date=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M" "$f" 2>/dev/null || stat --format="%y" "$f" 2>/dev/null | cut -d. -f1)
    printf "  %-50s %6s   %s\n" "$fname" "$size" "$date"
  done

  echo ""
  echo "  Total files: $(ls -1 "$RESULTS_DIR"/*.log 2>/dev/null | wc -l | xargs)"
  echo "  Total size:  $(du -sh "$RESULTS_DIR" | cut -f1 | xargs)"
  echo ""
}

# ── Show latest result ───────────────────────────────────────────
show_latest() {
  local latest=$(ls -t "$RESULTS_DIR"/*.log 2>/dev/null | head -1)
  if [ -z "$latest" ]; then
    echo "No results found."
    exit 0
  fi

  echo ""
  echo "═══════════════════════════════════════════════════════════"
  echo "  LATEST RESULT: $(basename "$latest")"
  echo "═══════════════════════════════════════════════════════════"
  echo ""
  cat "$latest"
}

# ── Export as CSV (extracts key metrics from log lines) ───────────
export_csv() {
  local csv_file="$RESULTS_DIR/summary_$(date +%Y%m%d_%H%M%S).csv"

  echo "filename,timestamp,type,size_bytes" > "$csv_file"

  for f in "$RESULTS_DIR"/*.log; do
    [ -f "$f" ] || continue
    local fname=$(basename "$f")
    local size=$(wc -c < "$f" | xargs)
    local date=$(stat -f "%Sm" -t "%Y-%m-%dT%H:%M:%S" "$f" 2>/dev/null || stat --format="%y" "$f" 2>/dev/null | cut -d. -f1)

    # Detect test type from filename
    local type="unknown"
    if echo "$fname" | grep -q "agent_load"; then type="agent_load_test"; fi
    if echo "$fname" | grep -q "media_load"; then type="media_load_test"; fi
    if echo "$fname" | grep -q "video_load"; then type="video_load_test"; fi
    if echo "$fname" | grep -q "quick_smoke"; then type="quick_smoke_test"; fi

    echo "$fname,$date,$type,$size" >> "$csv_file"
  done

  echo "  CSV exported -> $csv_file"
  echo ""
  cat "$csv_file"
}

# ── Package results into a zip ───────────────────────────────────
export_zip() {
  local zip_name="livekit-results_$(date +%Y%m%d_%H%M%S).zip"
  local zip_path="$SCRIPT_DIR/$zip_name"

  cd "$SCRIPT_DIR"
  zip -j "$zip_path" "$RESULTS_DIR"/*.log 2>/dev/null

  echo ""
  echo "  Results packaged -> $zip_path"
  echo "  Size: $(du -h "$zip_path" | cut -f1 | xargs)"
  echo ""
  echo "  Share this zip for review."
}

# ── Clean all results ────────────────────────────────────────────
clean_results() {
  local count=$(ls -1 "$RESULTS_DIR"/*.log 2>/dev/null | wc -l | xargs)

  if [ "$count" -eq 0 ]; then
    echo "  No results to clean."
    exit 0
  fi

  echo "  About to delete $count result files from $RESULTS_DIR"
  read -p "  Are you sure? (y/N): " confirm

  if [ "$confirm" = "y" ] || [ "$confirm" = "Y" ]; then
    rm -f "$RESULTS_DIR"/*.log "$RESULTS_DIR"/*.csv
    echo "  Cleaned."
  else
    echo "  Cancelled."
  fi
}

# ── CLI Router ───────────────────────────────────────────────────
print_usage() {
  cat <<'USAGE'
Export & Review Test Results
============================

Usage:
  ./export-results.sh              Show summary of all results
  ./export-results.sh latest       Show the latest result in full
  ./export-results.sh csv          Export result metadata as CSV
  ./export-results.sh zip          Package all results into a zip file
  ./export-results.sh clean        Delete all result files
USAGE
}

case "${1:-summary}" in
  summary) show_summary ;;
  latest)  show_latest ;;
  csv)     export_csv ;;
  zip)     export_zip ;;
  clean)   clean_results ;;
  help)    print_usage ;;
  *)       print_usage ;;
esac

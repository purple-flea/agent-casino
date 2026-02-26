#!/bin/bash
# Casino Smoke Test — checks all public endpoints return 200
# Usage: ./casino-smoke-test.sh [BASE_URL]
# Default BASE_URL: http://localhost:3000

BASE_URL="${1:-http://localhost:3000}"
PASS=0
FAIL=0
ERRORS=()

check() {
  local method="$1"
  local path="$2"
  local desc="$3"
  local body="$4"
  local expected="${5:-200}"

  if [ -n "$body" ]; then
    status=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" \
      -H "Content-Type: application/json" \
      -d "$body" \
      "${BASE_URL}${path}")
  else
    status=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" "${BASE_URL}${path}")
  fi

  if [ "$status" = "$expected" ]; then
    echo "  ✓ $method $path ($desc) → $status"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $method $path ($desc) → $status (expected $expected)"
    FAIL=$((FAIL + 1))
    ERRORS+=("$method $path: got $status, expected $expected")
  fi
}

echo "=== Casino Smoke Test ==="
echo "Target: $BASE_URL"
echo ""

echo "--- Public endpoints ---"
check GET /health "health check"
check GET /api/v1/gossip "gossip"
check GET /api/v1/public-stats "public stats"
check GET /api/v1/games "game list"
check GET /api/v1/recent-wins "recent wins"
check GET /api/v1/challenges/open "open challenges"
check GET /api/v1/stats/leaderboard "leaderboard"
check GET /api/v1/pricing "pricing"
check GET /api/v1/game-stats "per-game analytics"
check GET /changelog "changelog"
check GET /robots.txt "robots.txt"
check GET /sitemap.xml "sitemap"
check GET /.well-known/agent.json "agent.json"
check GET /.well-known/purpleflea.json "purpleflea.json"
check GET /network "network"
check GET /openapi.json "openapi spec"
check GET /llms.txt "llms.txt"
check GET /favicon.ico "favicon" "" 204
check GET /ping "ping"

echo ""
echo "--- Demo endpoint ---"
check POST /api/v1/demo "demo coin_flip" '{"game":"coin_flip","amount":1,"choice":"heads"}'

echo ""
echo "--- Auth endpoints return 401 without token ---"
check GET /api/v1/auth/balance "balance (no auth)" "" 401
check POST /api/v1/auth/withdraw "withdraw (no auth)" '{"amount":1,"address":"0x1"}' 401

echo ""
echo "--- 404 handling ---"
check GET /nonexistent-path "404 handler" "" 404

echo ""
echo "==========================="
echo "Results: $PASS passed, $FAIL failed"
if [ ${#ERRORS[@]} -gt 0 ]; then
  echo ""
  echo "FAILURES:"
  for err in "${ERRORS[@]}"; do
    echo "  - $err"
  done
  exit 1
else
  echo "All checks passed!"
  exit 0
fi

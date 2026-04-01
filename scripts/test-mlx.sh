#!/usr/bin/env bash
# MLX integration test suite for NanoClaw
# Tests: config, host connectivity, container connectivity, MCP server functionality
#
# Usage: ./scripts/test-mlx.sh [--skip-container] [--skip-mcp]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT/.env"

SKIP_CONTAINER=false
SKIP_MCP=false
for arg in "$@"; do
  [[ "$arg" == "--skip-container" ]] && SKIP_CONTAINER=true
  [[ "$arg" == "--skip-mcp" ]] && SKIP_MCP=true
done

# ── Counters ──────────────────────────────────────────────────────────────────

PASS=0
FAIL=0
SKIP=0

pass()  { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail()  { echo "  ✗ $1"; [[ -n "${2:-}" ]] && echo "    $2"; FAIL=$((FAIL + 1)); }
skip()  { echo "  - $1 (skipped)"; SKIP=$((SKIP + 1)); }
header(){ echo; echo "── $1 ──"; }

# ── Load .env ─────────────────────────────────────────────────────────────────

if [[ -f "$ENV_FILE" ]]; then
  # Parse .env safely: extract KEY=VALUE lines without eval or sourcing
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
    key="${key%%[[:space:]]*}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    value="${value%%[[:space:]]}"
    # Strip surrounding quotes if present
    value="${value%\"}" ; value="${value#\"}"
    value="${value%\'}" ; value="${value#\'}"
    export "$key=$value"
  done < "$ENV_FILE"
fi

MLX_HOST="${MLX_HOST:-}"

# ── Section 1: Configuration ──────────────────────────────────────────────────

header "Section 1: Configuration"

if [[ -n "$MLX_HOST" ]]; then
  pass "MLX_HOST is set ($MLX_HOST)"
else
  fail "MLX_HOST is not set in .env" "Add: MLX_HOST=http://192.168.64.1:11435"
fi

if echo "$MLX_HOST" | grep -qE ':11435'; then
  pass "MLX_HOST uses port 11435"
else
  fail "MLX_HOST does not use port 11435" "Got: $MLX_HOST"
fi

MLX_SRC="$ROOT/container/agent-runner/src/mlx-mcp-stdio.ts"
if [[ -f "$MLX_SRC" ]]; then
  pass "mlx-mcp-stdio.ts source file exists"
else
  fail "mlx-mcp-stdio.ts not found" "Expected: $MLX_SRC"
fi

AGENT_INDEX="$ROOT/container/agent-runner/src/index.ts"
if grep -q "'mcp__mlx__\*'" "$AGENT_INDEX" 2>/dev/null; then
  pass "mcp__mlx__* in allowedTools"
else
  fail "mcp__mlx__* not found in allowedTools" "Check: $AGENT_INDEX"
fi

if grep -q 'mlx-mcp-stdio\.js' "$AGENT_INDEX" 2>/dev/null; then
  pass "mlx-mcp-stdio.js registered in mcpServers"
else
  fail "mlx-mcp-stdio.js not registered" "Check mcpServers in $AGENT_INDEX"
fi

# ── Section 2: Host connectivity ──────────────────────────────────────────────

header "Section 2: Host connectivity (MLX)"

if [[ -z "$MLX_HOST" ]]; then
  skip "MLX host check (MLX_HOST not set)"
else
  # /v1/models — standard OpenAI-compatible endpoint listing
  HTTP_STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$MLX_HOST/v1/models" 2>/dev/null || echo "000")
  if [[ "$HTTP_STATUS" == "200" ]]; then
    pass "GET $MLX_HOST/v1/models → 200"
  elif [[ "$HTTP_STATUS" == "000" ]]; then
    fail "Cannot reach $MLX_HOST/v1/models" "MLX server may not be running — check: mlx_lm.server"
  else
    fail "GET $MLX_HOST/v1/models → $HTTP_STATUS" "Unexpected status from MLX endpoint"
  fi

  # Fetch the first loaded model name to use in the live generation test
  MLX_MODEL_ID=$(curl -s --max-time 5 "$MLX_HOST/v1/models" 2>/dev/null \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['data'][0]['id'])" 2>/dev/null || echo "")

  if [[ -z "$MLX_MODEL_ID" ]]; then
    skip "Live generation test (no model loaded — start one with: mlx_lm.server --model <name>)"
  else
    CHAT_RESP=$(curl -s -w "\n%{http_code}" --max-time 60 \
      -X POST "$MLX_HOST/v1/chat/completions" \
      -H 'Content-Type: application/json' \
      -d "{\"model\":\"$MLX_MODEL_ID\",\"messages\":[{\"role\":\"user\",\"content\":\"say hi\"}],\"max_tokens\":5}" \
      2>/dev/null || echo -e "\n000")
    CHAT_STATUS=$(echo "$CHAT_RESP" | tail -1)
    if [[ "$CHAT_STATUS" == "200" ]]; then
      pass "POST $MLX_HOST/v1/chat/completions with $MLX_MODEL_ID → 200"
    elif [[ "$CHAT_STATUS" == "000" ]]; then
      fail "POST $MLX_HOST/v1/chat/completions timed out" \
        "Model may still be loading — try again in a moment"
    else
      fail "POST $MLX_HOST/v1/chat/completions → $CHAT_STATUS"
    fi
  fi
fi

header "Section 2b: Host connectivity (Ollama)"

OLLAMA_HOST="${OLLAMA_HOST:-}"
if [[ -z "$OLLAMA_HOST" ]]; then
  skip "Ollama host check (OLLAMA_HOST not set)"
else
  OLLAMA_STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$OLLAMA_HOST/api/tags" 2>/dev/null || echo "000")
  if [[ "$OLLAMA_STATUS" == "200" ]]; then
    pass "GET $OLLAMA_HOST/api/tags → 200"
  elif [[ "$OLLAMA_STATUS" == "000" ]]; then
    fail "Cannot reach $OLLAMA_HOST/api/tags" "Ollama may not be running — check: ollama serve"
  else
    fail "GET $OLLAMA_HOST/api/tags → $OLLAMA_STATUS"
  fi
fi

# ── Section 3: MCP servers inside container (real runtime path) ───────────────
# This is what NanoClaw actually does: compile agent-runner, spawn MCP server,
# call tools via JSON-RPC. Tests that MLX_HOST and OLLAMA_HOST are forwarded.

header "Section 3: MCP servers inside container"

# Find the most recently updated agent-runner-src dir
AGENT_SRC=$(ls -dt "$ROOT"/data/sessions/*/agent-runner-src 2>/dev/null | head -1)

if [[ "$SKIP_CONTAINER" == "true" ]]; then
  skip "Container MCP tests (--skip-container)"
elif ! command -v container &>/dev/null; then
  skip "Container MCP tests (container runtime not found)"
elif [[ -z "$AGENT_SRC" ]]; then
  skip "Container MCP tests (no agent-runner-src directory found — process a message first)"
else
  echo "  Using agent-runner source: $AGENT_SRC"

  # ── MLX inside container ────────────────────────────────────────────────────
  if [[ -z "$MLX_HOST" ]]; then
    skip "MLX container MCP test (MLX_HOST not set)"
  else
    echo "  Compiling agent-runner and testing mlx_generate inside container..."
    MLX_RESULT=$(container run --rm \
      -e MLX_HOST="$MLX_HOST" \
      --mount "type=bind,source=$AGENT_SRC,target=/app/src" \
      --entrypoint bash \
      nanoclaw-agent:latest \
      -c 'cd /app && npx tsc --outDir /tmp/dist 2>/dev/null
          ln -s /app/node_modules /tmp/dist/node_modules 2>/dev/null || true
          printf "%s\n" \
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"t\",\"version\":\"1\"}}}" \
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\",\"params\":{}}" \
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"mlx_generate\",\"arguments\":{\"prompt\":\"say hi\",\"max_tokens\":5}}}" \
          | timeout 90 node /tmp/dist/mlx-mcp-stdio.js 2>/dev/null' \
      2>/dev/null || echo "CONTAINER_ERROR")

    if echo "$MLX_RESULT" | grep -q '"result".*"content"'; then
      pass "mlx_generate tool call succeeds inside container (MLX_HOST=$MLX_HOST)"
      # Check it didn't fall back to host.docker.internal
      if echo "$MLX_RESULT" | grep -q 'host.docker.internal'; then
        fail "Response mentions host.docker.internal — MLX_HOST env var not reaching MCP server"
      else
        pass "MLX_HOST env var correctly forwarded to MCP subprocess"
      fi
    elif echo "$MLX_RESULT" | grep -qi 'failed to connect\|timed out\|ECONNREFUSED'; then
      fail "mlx_generate: MCP server cannot reach MLX" "$MLX_RESULT"
    elif [[ "$MLX_RESULT" == "CONTAINER_ERROR" ]]; then
      fail "Container failed to start for MLX test"
    else
      fail "mlx_generate returned unexpected response" "$(echo "$MLX_RESULT" | tail -3)"
    fi
  fi

  # ── Ollama inside container ─────────────────────────────────────────────────
  OLLAMA_HOST="${OLLAMA_HOST:-}"
  if [[ -z "$OLLAMA_HOST" ]]; then
    skip "Ollama container MCP test (OLLAMA_HOST not set)"
  else
    echo "  Testing ollama_list_models inside container..."
    OLLAMA_RESULT=$(container run --rm \
      -e OLLAMA_HOST="$OLLAMA_HOST" \
      --mount "type=bind,source=$AGENT_SRC,target=/app/src" \
      --entrypoint bash \
      nanoclaw-agent:latest \
      -c 'cd /app && npx tsc --outDir /tmp/dist 2>/dev/null
          ln -s /app/node_modules /tmp/dist/node_modules 2>/dev/null || true
          printf "%s\n" \
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"t\",\"version\":\"1\"}}}" \
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\",\"params\":{}}" \
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"ollama_list_models\",\"arguments\":{}}}" \
          | timeout 30 node /tmp/dist/ollama-mcp-stdio.js 2>/dev/null' \
      2>/dev/null || echo "CONTAINER_ERROR")

    if echo "$OLLAMA_RESULT" | grep -q '"result".*"content"'; then
      pass "ollama_list_models tool call succeeds inside container (OLLAMA_HOST=$OLLAMA_HOST)"
    elif echo "$OLLAMA_RESULT" | grep -qi 'failed to connect\|ECONNREFUSED'; then
      fail "ollama_list_models: MCP server cannot reach Ollama" "$OLLAMA_RESULT"
    elif [[ "$OLLAMA_RESULT" == "CONTAINER_ERROR" ]]; then
      fail "Container failed to start for Ollama test"
    else
      fail "ollama_list_models returned unexpected response" "$(echo "$OLLAMA_RESULT" | tail -3)"
    fi
  fi
fi

# ── Section 4: MCP server functionality ──────────────────────────────────────

header "Section 4: MCP server unit tests (host)"

if [[ "$SKIP_MCP" == "true" ]]; then
  skip "MCP unit tests (--skip-mcp)"
elif ! command -v node &>/dev/null; then
  skip "MCP unit tests (node not found)"
else
  echo "  Running MCP JSON-RPC unit tests (mock server, host-side tsx)..."
  if node "$SCRIPT_DIR/test-mlx-mcp.mjs"; then
    : # pass/fail printed by the script itself
  else
    echo "  (MCP test script exited with error)"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo
echo "────────────────────────────"
echo "  Results: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped"
echo "────────────────────────────"
echo

if [[ $FAIL -gt 0 ]]; then
  echo "  One or more checks failed. Common fixes:"
  echo
  echo "  • Start MLX server on the host:"
  echo "    mlx_lm.server --host 0.0.0.0 --port 11435 --model mlx-community/Nemotron-Cascade-2-30B-A3B-4bit"
  echo
  echo "  • Set MLX_HOST in .env:"
  echo "    echo 'MLX_HOST=http://192.168.64.1:11435' >> .env"
  echo
  echo "  • Rebuild container image after code changes:"
  echo "    ./container/build.sh"
  echo
  exit 1
fi

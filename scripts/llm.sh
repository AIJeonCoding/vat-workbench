#!/usr/bin/env bash
# 로컬 Qwen(MLX)을 OpenAI 호환 서버로 띄운다. 기본: Qwen3.6-35B-A3B 4bit-DWQ, 포트 8080
set -euo pipefail
MODEL="${LLM_MODEL:-mlx-community/Qwen3.6-35B-A3B-4bit-DWQ}"
VENV="${MLX_VENV:-$HOME/ai-llm/.venv}"
exec "$VENV/bin/mlx_lm.server" --model "$MODEL" --host 127.0.0.1 --port "${LLM_PORT:-8080}"

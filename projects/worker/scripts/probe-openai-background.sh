#!/usr/bin/env bash
# Probe: can Responses API background mode drive gpt-image-2?
# Usage: OPENAI_API_KEY=sk-... ./probe-openai-background.sh
set -euo pipefail
SUBMIT=$(curl -s https://api.openai.com/v1/responses \
  -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5-mini",
    "background": true,
    "store": true,
    "input": "Call the image generation tool with exactly this prompt, verbatim, then stop: a watercolor fox in morning fog",
    "tools": [{"type": "image_generation", "model": "gpt-image-2", "size": "1024x1024", "quality": "medium", "output_format": "webp", "output_compression": 85}],
    "tool_choice": "required"
  }')
echo "$SUBMIT" | head -c 2000; echo
ID=$(echo "$SUBMIT" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "response id: $ID — polling..."
for i in $(seq 1 60); do
  sleep 5
  R=$(curl -s "https://api.openai.com/v1/responses/$ID" -H "Authorization: Bearer $OPENAI_API_KEY")
  STATUS=$(echo "$R" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status'))")
  echo "[$((i*5))s] $STATUS"
  case "$STATUS" in
    completed) echo "$R" | python3 -c "
import json,sys
r = json.load(sys.stdin)
for item in r.get('output', []):
    if item.get('type') == 'image_generation_call':
        print('image bytes (b64) length:', len(item.get('result') or ''))
        print('revised_prompt:', item.get('revised_prompt'))
"; exit 0;;
    failed|cancelled|incomplete) echo "$R" | head -c 2000; exit 1;;
  esac
done
echo "probe timed out"; exit 1

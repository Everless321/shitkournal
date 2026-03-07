#!/usr/bin/env bash
# 预热全站 PDF 到 R2
# Usage: ./warm.sh [base_url]

BASE="${1:-https://shit.everless.dev}"
API="https://api.shitjournal.org/api"

DIM='\033[2m'
BOLD='\033[1m'
GREEN='\033[32m'
CYAN='\033[36m'
RED='\033[31m'
RESET='\033[0m'

echo ""
echo -e "${BOLD}S.H.I.T Journal R2 Warm-up${RESET}"
echo -e "${DIM}Worker: ${BASE}${RESET}"
echo -e "${DIM}Source: ${API}${RESET}"
echo ""

# 1. 收集所有预印本 ID
echo -e "${CYAN}▶${RESET} Collecting preprint IDs from all zones..."
IDS=""
TOTAL=0

for zone in septic stone sediment latrine; do
  page=1
  while true; do
    data=$(curl -s --max-time 10 "${API}/articles/?zone=${zone}&page=${page}")
    count=$(echo "$data" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('data',[])))" 2>/dev/null)
    pages=$(echo "$data" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('total_pages',0))" 2>/dev/null)

    if [ -z "$count" ] || [ "$count" = "0" ]; then break; fi

    new_ids=$(echo "$data" | python3 -c "
import sys,json
d = json.load(sys.stdin)
for a in d.get('data',[]):
    print(a['id'])
" 2>/dev/null)

    IDS="${IDS}${new_ids}"$'\n'
    TOTAL=$((TOTAL + count))

    echo -e "  ${DIM}${zone} page ${page}/${pages}: +${count}${RESET}"

    if [ "$page" -ge "$pages" ]; then break; fi
    page=$((page + 1))
    sleep 0.5
  done
done

# 去重
IDS=$(echo "$IDS" | sort -u | sed '/^$/d')
UNIQUE=$(echo "$IDS" | wc -l | tr -d ' ')

echo ""
echo -e "${GREEN}✓${RESET} Found ${BOLD}${UNIQUE}${RESET} preprints with PDF"
echo ""

# 2. 逐个预热
CACHED=0
EXISTS=0
FAILED=0
COUNT=0

echo -e "${CYAN}▶${RESET} Warming PDFs to R2..."
echo ""

while IFS= read -r id; do
  [ -z "$id" ] && continue
  COUNT=$((COUNT + 1))

  result=$(curl -s --max-time 120 "${BASE}/api/warm?id=${id}")
  status=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','error'))" 2>/dev/null)
  size=$(echo "$result" | python3 -c "import sys,json; s=json.load(sys.stdin).get('size',0); print(f'{s/1024:.0f}KB') if s else print('')" 2>/dev/null)

  case "$status" in
    exists)
      echo -e "  ${DIM}[${COUNT}/${UNIQUE}]${RESET} ${id:0:8}... ${DIM}R2 exists ${size}${RESET}"
      EXISTS=$((EXISTS + 1))
      ;;
    cached)
      echo -e "  ${DIM}[${COUNT}/${UNIQUE}]${RESET} ${id:0:8}... ${GREEN}cached ${size}${RESET}"
      CACHED=$((CACHED + 1))
      ;;
    *)
      echo -e "  ${DIM}[${COUNT}/${UNIQUE}]${RESET} ${id:0:8}... ${RED}${status}${RESET}"
      FAILED=$((FAILED + 1))
      ;;
  esac

  sleep 0.5
done <<< "$IDS"

echo ""
echo -e "${DIM}────────────────────────────────────────${RESET}"
echo -e "  ${GREEN}✓${RESET} ${BOLD}Done${RESET}"
echo -e "  ${DIM}total:${RESET}   ${UNIQUE}"
echo -e "  ${DIM}cached:${RESET}  ${GREEN}${CACHED}${RESET} (new → R2)"
echo -e "  ${DIM}exists:${RESET}  ${EXISTS} (already in R2)"
echo -e "  ${DIM}failed:${RESET}  ${RED}${FAILED}${RESET}"
echo -e "${DIM}────────────────────────────────────────${RESET}"
echo ""

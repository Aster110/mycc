#!/bin/bash
# Stop MyCC Backend
# Run: ./stop-mycc.sh

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo ""
echo "============================================" | sed $'s/$/\\e[0;36m/'
echo "       Stopping MyCC Backend" | sed $'s/$/\\e[0;36m/'
echo "============================================" | sed $'s/$/\\e[0;36m/'
echo ""

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Stop by port
echo -e "${YELLOW}Stopping backend on port 18080...${NC}"

if lsof -Pi :18080 -sTCP:LISTEN -t >/dev/null 2>&1; then
    PID=$(lsof -Pi :18080 -sTCP:LISTEN -t)
    echo -e "  ${CYAN}Killing process $PID...${NC}"
    kill -9 "$PID" 2>/dev/null || true
    sleep 1

    if lsof -Pi :18080 -sTCP:LISTEN -t >/dev/null 2>&1; then
        echo -e "  ${RED}Failed to stop process${NC}"
    else
        echo -e "  ${GREEN}✓ Backend stopped${NC}"
    fi
else
    echo -e "  ${YELLOW}No process found on port 18080${NC}"
fi

# Kill cloudflared processes
echo ""
echo -e "${YELLOW}Stopping cloudflared processes...${NC}"
if pgrep -f "cloudflared tunnel" >/dev/null 2>&1; then
    pkill -9 -f "cloudflared tunnel" 2>/dev/null || true
    echo -e "  ${GREEN}✓ Cloudflared stopped${NC}"
else
    echo -e "  ${YELLOW}No cloudflared processes found${NC}"
fi

echo ""
echo "============================================" | sed $'s/$/\\e[0;36m/'
echo "  All services stopped" | sed $'s/$/\\e[0;32m/'
echo "============================================" | sed $'s/$/\\e[0;36m/'
echo ""

#!/bin/bash
# MyCC Backend One-Click Startup Script
# Run: ./start-mycc.sh

set -e

# Configuration
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$PROJECT_DIR/.claude/skills/mycc/scripts"
LOG_FILE="$PROJECT_DIR/.claude/skills/mycc/backend.log"
CONFIG_FILE="$PROJECT_DIR/.claude/skills/mycc/current.json"
ENV_FILE="$PROJECT_DIR/.env"
TSX_BIN="$SCRIPT_DIR/node_modules/.bin/tsx"

# Load .env file if exists
if [ -f "$ENV_FILE" ]; then
    export $(grep -v '^#' "$ENV_FILE" | xargs)
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;37m'
WHITE='\033[1;37m'
NC='\033[0m' # No Color

clear

echo ""
echo "============================================" | sed $'s/$/\\e[0;36m/'
echo "       MyCC Backend v0.5.1" | sed $'s/$/\\e[0;36m/'
echo "       + 飞书通道 (Feishu)" | sed $'s/$/\\e[0;36m/'
echo "============================================" | sed $'s/$/\\e[0;36m/'
echo ""

# Check dependencies
echo -e "${YELLOW}[1/5] Checking dependencies...${NC}"

if [ ! -f "$TSX_BIN" ]; then
    echo -e "  ${RED}ERROR: tsx not found!${NC}"
    echo -e "  ${GRAY}Run: cd $SCRIPT_DIR && npm install${NC}"
    echo ""
    read -p "Press Enter to exit"
    exit 1
fi
echo -e "  ${GREEN}tsx: OK${NC}"

if command -v claude &> /dev/null; then
    echo -e "  ${GREEN}Claude Code: OK${NC}"
else
    echo -e "  ${YELLOW}WARNING: Claude Code CLI not found in PATH${NC}"
fi

if command -v cloudflared &> /dev/null; then
    echo -e "  ${GREEN}cloudflared: OK${NC}"
else
    echo -e "  ${YELLOW}WARNING: cloudflared not found in PATH${NC}"
fi

# Feishu configuration
if [ -n "$FEISHU_APP_ID" ]; then
    echo -e "  ${GRAY}Feishu App ID: $FEISHU_APP_ID${NC}"
fi
if [ -n "$FEISHU_RECEIVE_USER_ID" ]; then
    echo -e "  ${GRAY}Feishu Group ID: $FEISHU_RECEIVE_USER_ID${NC}"
fi

echo ""

# Check and stop existing process
echo -e "${YELLOW}[2/5] Checking port 18080...${NC}"
if lsof -Pi :18080 -sTCP:LISTEN -t >/dev/null 2>&1; then
    PID=$(lsof -Pi :18080 -sTCP:LISTEN -t)
    echo -e "  ${RED}Port occupied (PID: $PID), stopping...${NC}"
    kill -9 "$PID" 2>/dev/null || true
    sleep 2
fi
echo -e "  ${GREEN}Port 18080 available${NC}"
echo ""

# Start backend
echo -e "${YELLOW}[3/5] Starting backend...${NC}"

# Clear old log
[ -f "$LOG_FILE" ] && rm -f "$LOG_FILE"

# Start in background using nohup
nohup "$TSX_BIN" "$SCRIPT_DIR/src/index.ts" start >> "$LOG_FILE" 2>&1 &
BACKEND_PID=$!

# Wait for process to start
sleep 3

# Check if port 18080 is now listening
if lsof -Pi :18080 -sTCP:LISTEN -t >/dev/null 2>&1; then
    NEW_PID=$(lsof -Pi :18080 -sTCP:LISTEN -t)
    echo -e "  ${GREEN}Backend started (PID: $NEW_PID)${NC}"
else
    echo -e "  ${YELLOW}WARNING: Port 18080 not listening yet${NC}"
fi

echo ""

# Wait for config file
echo -e "${YELLOW}[4/5] Waiting for service ready...${NC}"
timeout=45
elapsed=0
while [ $elapsed -lt $timeout ]; do
    if [ -f "$CONFIG_FILE" ]; then
        if command -v jq &> /dev/null; then
            routeToken=$(jq -r '.routeToken // empty' "$CONFIG_FILE" 2>/dev/null)
            pairCode=$(jq -r '.pairCode // empty' "$CONFIG_FILE" 2>/dev/null)
            tunnelUrl=$(jq -r '.tunnelUrl // empty' "$CONFIG_FILE" 2>/dev/null)
            if [ -n "$routeToken" ] && [ -n "$pairCode" ] && [ -n "$tunnelUrl" ]; then
                break
            fi
        else
            # Fallback: grep
            if grep -q '"routeToken"' "$CONFIG_FILE" && \
               grep -q '"pairCode"' "$CONFIG_FILE" && \
               grep -q '"tunnelUrl"' "$CONFIG_FILE"; then
                break
            fi
        fi
    fi
    sleep 1
    elapsed=$((elapsed + 1))
    echo -ne "  Waiting... ($elapsed/$timeout sec)\r"
done

echo ""

# Check if started successfully
if [ ! -f "$CONFIG_FILE" ]; then
    echo ""
    echo -e "  ${RED}ERROR: Startup timeout!${NC}"
    echo -e "  ${GRAY}Check log: tail -50 '$LOG_FILE'${NC}"
    echo ""
    read -p "Press Enter to exit"
    exit 1
fi

# Read connection info
echo ""
echo "============================================" | sed $'s/$/\\e[0;36m/'
echo "           Service Started!" | sed $'s/$/\\e[0;32m/'
echo "============================================" | sed $'s/$/\\e[0;36m/'
echo ""
echo -e "${WHITE}+------------------------------------------+${NC}"
echo -e "${WHITE}|  Connect from your phone:                |${NC}"
echo -e "${WHITE}+------------------------------------------+${NC}"

if command -v jq &> /dev/null; then
    mpUrl=$(jq -r '.mpUrl' "$CONFIG_FILE")
    routeToken=$(jq -r '.routeToken' "$CONFIG_FILE")
    pairCode=$(jq -r '.pairCode' "$CONFIG_FILE")
    tunnelUrl=$(jq -r '.tunnelUrl' "$CONFIG_FILE")
else
    mpUrl=$(grep '"mpUrl"' "$CONFIG_FILE" | cut -d'"' -f4)
    routeToken=$(grep '"routeToken"' "$CONFIG_FILE" | cut -d'"' -f4)
    pairCode=$(grep '"pairCode"' "$CONFIG_FILE" | cut -d'"' -f4)
    tunnelUrl=$(grep '"tunnelUrl"' "$CONFIG_FILE" | cut -d'"' -f4)
fi

echo -e "|  ${CYAN}MiniApp URL: ${mpUrl}${NC} |"
echo -e "|  ${YELLOW}Route Token: ${routeToken}${NC} |"
echo -e "|  ${YELLOW}Pair Code:    ${pairCode}${NC} |"
echo -e "|  ${GRAY}Tunnel:       ${tunnelUrl:0:50}${NC} |"
if [ ${#tunnelUrl} -gt 50 ]; then
    echo -e "|               ${tunnelUrl:50}${NC} |"
fi
echo -e "${WHITE}+------------------------------------------+${NC}"
echo ""

# Feishu channel status
if [ -n "$FEISHU_APP_ID" ]; then
    echo -e "${WHITE}+------------------------------------------+${NC}"
    echo -e "${WHITE}|  Feishu Channel Enabled:                  |${NC}"
    echo -e "${WHITE}+------------------------------------------+${NC}"
    echo -e "|  ${CYAN}Feishu Group:   ${FEISHU_RECEIVE_USER_ID}${NC} |"
    echo -e "|  ${GREEN}Status: ✓ Connected (WebSocket mode)${NC}    |"
    echo -e "${WHITE}+------------------------------------------+${NC}"
    echo ""
fi

# Open browser
echo "Opening browser..."
if command -v open &> /dev/null; then
    # macOS
    open "$mpUrl" 2>/dev/null || true
elif command -v xdg-open &> /dev/null; then
    # Linux
    xdg-open "$mpUrl" 2>/dev/null || true
else
    echo -e "  ${YELLOW}Failed to open browser${NC}"
fi

echo ""
echo "============================================" | sed $'s/$/\\e[0;36m/'
echo "  Commands:" | sed $'s/$/\\e[0;36m/'
echo "============================================" | sed $'s/$/\\e[0;36m/'
echo ""
echo -e "  ${GRAY}View logs (live):${NC}"
echo -e "    ${GRAY}tail -f '$LOG_FILE'${NC}"
echo ""
echo -e "  ${GRAY}Stop service:${NC}"
echo -e "    ${GRAY}./stop-mycc.sh${NC}"
echo ""
echo -e "  ${GRAY}Or kill by port:${NC}"
echo -e "    ${GRAY}lsof -i :18080 -t | xargs kill${NC}"
echo ""
echo "============================================" | sed $'s/$/\\e[0;36m/'
echo ""

# Show initial logs
echo "Showing initial logs (will exit in 30s)..."
echo ""

timeout_end=$(($(date +%s) + 30))
last_line_count=0
while [ $(date +%s) -lt $timeout_end ]; do
    if [ -f "$LOG_FILE" ]; then
        current_line_count=$(wc -l < "$LOG_FILE")
        if [ $current_line_count -gt $last_line_count ]; then
            tail -n +$((last_line_count + 1)) "$LOG_FILE"
            last_line_count=$current_line_count
        fi
    fi
    sleep 1
done

echo ""
echo "============================================" | sed $'s/$/\\e[0;36m/'
echo "  Startup script exiting..." | sed $'s/$/\\e[0;32m/'
echo "  Backend continues running in background" | sed $'s/$/\\e[0;32m/'
echo "============================================" | sed $'s/$/\\e[0;36m/'
echo ""

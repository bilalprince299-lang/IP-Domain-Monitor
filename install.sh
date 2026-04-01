#!/bin/bash
# ============================================
# AL KHALEEJ IP MONITER - One Click Installer
# ============================================

set -e

echo ""
echo "======================================"
echo "  AL KHALEEJ IP MONITER - Installing..."
echo "======================================"
echo ""

# Detect current user and home directory
USER_HOME="$HOME"
USERNAME=$(whoami)
INSTALL_DIR="$USER_HOME/IP-Domain-Monitor"

# Check if Node.js is installed
NODE_PATH=""
if command -v node &>/dev/null; then
    NODE_PATH=$(which node)
elif [ -f /opt/homebrew/bin/node ]; then
    NODE_PATH="/opt/homebrew/bin/node"
elif [ -f /usr/local/bin/node ]; then
    NODE_PATH="/usr/local/bin/node"
else
    echo "Node.js nahi mila! Pehle install karo:"
    echo "  /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
    echo "  brew install node"
    exit 1
fi

echo "Node.js found: $NODE_PATH"
echo "Install directory: $INSTALL_DIR"
echo ""

# Clone or update repo
if [ -d "$INSTALL_DIR" ]; then
    echo "Updating existing installation..."
    cd "$INSTALL_DIR"
    git pull origin main
else
    echo "Cloning repository..."
    git clone https://github.com/bilalprince299-lang/IP-Domain-Monitor.git "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# Install dependencies
echo "Installing dependencies..."
NPM_PATH=$(dirname "$NODE_PATH")/npm
"$NPM_PATH" install

# Create data directory
mkdir -p "$INSTALL_DIR/data"

# Generate plist with correct paths
PLIST_FILE="$USER_HOME/Library/LaunchAgents/com.ipmonitor.plist"

cat > "$PLIST_FILE" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.ipmonitor</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${INSTALL_DIR}/server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${INSTALL_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${INSTALL_DIR}/data/server.log</string>
    <key>StandardErrorPath</key>
    <string>${INSTALL_DIR}/data/error.log</string>
</dict>
</plist>
PLIST

# Load LaunchAgent
launchctl unload "$PLIST_FILE" 2>/dev/null || true
launchctl load "$PLIST_FILE"

# Wait for server to start
sleep 3

# Check if running
if curl -s -o /dev/null -w "%{http_code}" http://localhost:2397/ | grep -q "200"; then
    echo ""
    echo "======================================"
    echo "  DONE! Software install ho gaya!"
    echo "======================================"
    echo ""
    echo "  Browser mein kholo: http://localhost:2397"
    echo ""
    echo "  Auto-start: ON (MacBook restart pe khud chalega)"
    echo "======================================"
    echo ""
    # Open in browser
    open http://localhost:2397
else
    echo ""
    echo "Server start ho raha hai... Browser mein kholo:"
    echo "  http://localhost:2397"
    echo ""
fi

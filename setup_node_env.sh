#!/bin/bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

if ! command -v pnpm &>/dev/null; then
    echo "Installing pnpm..."
    npm install -g pnpm
fi

echo "node $(node --version)"
echo "npm  $(npm --version)"
echo "pnpm $(pnpm --version)"
echo "Environment ready."

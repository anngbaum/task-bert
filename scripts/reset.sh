#!/bin/bash
set -e

echo "Resetting Bert for a fresh setup..."

# 1. Remove UserDefaults
echo "Removing UserDefaults..."
defaults delete com.opensearch.app 2>/dev/null && echo "  Defaults removed." || echo "  No defaults found."

# 2. Remove Keychain keys
echo "Removing Keychain keys..."
security delete-generic-password -s "com.bert.api-keys" -a "anthropic" 2>/dev/null && echo "  Anthropic key removed." || echo "  No Anthropic key found."
security delete-generic-password -s "com.bert.api-keys" -a "openai" 2>/dev/null && echo "  OpenAI key removed." || echo "  No OpenAI key found."

# 3. Remove Application Support folder
echo "Removing Application Support folder..."
rm -rf ~/Library/Application\ Support/Bert && echo "  Application Support removed." || echo "  No Application Support folder found."

echo "Done! Bert is ready for a fresh setup."

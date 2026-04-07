#!/usr/bin/env bash
# List GitHub release downloads by version for anngbaum/task-bert

set -euo pipefail

REPO="anngbaum/task-bert"

releases=$(gh api "repos/$REPO/releases" --paginate --jq '.[] | {tag: .tag_name, published: .published_at, assets: [.assets[] | {name: .name, downloads: .download_count}]}')

if [ -z "$releases" ]; then
  echo "No releases found for $REPO"
  exit 0
fi

total=0

echo "$releases" | jq -r '
  "  \(.tag)  (\(.published | split("T")[0]))",
  (.assets[] | "    \(.name)  \(.downloads) downloads"),
  ""
'

grand_total=$(echo "$releases" | jq -s '[.[].assets[].downloads] | add // 0')
echo "Total downloads: $grand_total"

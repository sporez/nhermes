#!/bin/sh
# Clone the pinned upstream projects into reference/ (see UPSTREAM.md).
set -eu
cd "$(dirname "$0")/.."
mkdir -p reference
pin() { # dir url commit
  [ -d "reference/$1/.git" ] || git clone --quiet "$2" "reference/$1"
  git -C "reference/$1" fetch --quiet --tags origin
  git -C "reference/$1" checkout --quiet "$3"
  echo "$1 $(git -C "reference/$1" rev-parse HEAD)"
}
pin pi https://github.com/earendil-works/pi 06a466935536f8c9bcacb2d5efc0fc021be1bdff

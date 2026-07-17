#!/bin/sh

set -eu

VERSION="${RELEASE_VERSION:-v1.0.9}"
RELEASE_DATE="${RELEASE_DATE:-2024-07-28T12:00:00+08:00}"
# 需要有权限的token github地址
REMOTE_URL=
REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DIST_DIR="$REPO_ROOT/dist"
RELEASE_DIR="$REPO_ROOT/release-push"

if [ -e "$RELEASE_DIR" ] || [ -L "$RELEASE_DIR" ]; then
  echo "Removing existing release directory: $RELEASE_DIR"
  rm -rf -- "$RELEASE_DIR"
fi

cd "$REPO_ROOT"
npm run build

if [ ! -d "$DIST_DIR" ]; then
  echo "Error: build output directory $DIST_DIR was not created." >&2
  exit 1
fi

mkdir "$RELEASE_DIR"
cp -R "$DIST_DIR/." "$RELEASE_DIR/"

cd "$RELEASE_DIR"
git init
git remote add origin "$REMOTE_URL"
git config user.name "infinitynodestudio"
git config user.email "infinitynodestudio@outlook.com"
git add .
GIT_AUTHOR_DATE="$RELEASE_DATE" GIT_COMMITTER_DATE="$RELEASE_DATE" \
  git commit -m "$VERSION"
GIT_COMMITTER_DATE="$RELEASE_DATE" git tag -a "$VERSION" -m "$VERSION"

git push origin "refs/tags/$VERSION" --force

echo "Published tag $VERSION"

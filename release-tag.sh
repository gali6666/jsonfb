#!/bin/sh

set -eu

VERSION="${RELEASE_VERSION:-v1.0.9}"
REMOTE_URL="${RELEASE_GIT_REMOTE_URL:-https://github.com/infinitynodestudio/jsonfb.git}"

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "Error: GITHUB_TOKEN is not set." >&2
  echo "Set it in the environment before running this script." >&2
  exit 1
fi
export GITHUB_TOKEN

case "$REMOTE_URL" in
  *://*@*)
    echo "Error: RELEASE_GIT_REMOTE_URL must not contain credentials." >&2
    echo "Provide the token through GITHUB_TOKEN instead." >&2
    exit 1
    ;;
esac

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
git commit -m "$VERSION"
git tag "$VERSION"

ASKPASS_SCRIPT=$(mktemp "${TMPDIR:-/tmp}/jsonfb-git-askpass.XXXXXX")
cleanup_askpass() {
  rm -f -- "$ASKPASS_SCRIPT"
}
trap cleanup_askpass EXIT

cat >"$ASKPASS_SCRIPT" <<'EOF'
#!/bin/sh

case "${1:-}" in
  *Username*) printf '%s\n' "x-access-token" ;;
  *Password*) printf '%s\n' "$GITHUB_TOKEN" ;;
  *) exit 1 ;;
esac
EOF
chmod 700 "$ASKPASS_SCRIPT"

GIT_ASKPASS="$ASKPASS_SCRIPT" GIT_TERMINAL_PROMPT=0 \
  git -c credential.helper= push origin "refs/tags/$VERSION" --force

echo "Published tag $VERSION to $REMOTE_URL"

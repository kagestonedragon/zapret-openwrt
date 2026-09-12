#!/bin/sh
# Copyright (c) 2026 zapret-openwrt
#
# Build the zapret + luci-app-zapret packages locally with the official OpenWrt SDK
# container. Builds the WORKING TREE, not HEAD, so uncommitted changes are included.
#
#   ./tools/build-docker.sh                                 # aarch64_cortex-a53, ipk (24.10)
#   ./tools/build-docker.sh --arch x86_64 --branch v23.05.5
#   ./tools/build-docker.sh --clean                         # drop the cached feeds/downloads
#
# The SDK branch decides the package format and must match the release on the router:
#   v23.05.x, v24.10.x -> ipk        v25.12.x, SNAPSHOT -> apk
#
# Results land in ./out/ .

set -e

ARCH=aarch64_cortex-a53
BRANCH=v24.10.5
OUT=
CLEAN=0
VERBOSE=0

usage() {
	sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'
	exit "${1:-0}"
}

while [ $# -gt 0 ]; do
	case "$1" in
		--arch)    ARCH="$2"; shift 2 ;;
		--branch)  BRANCH="$2"; shift 2 ;;
		--out)     OUT="$2"; shift 2 ;;
		--clean)   CLEAN=1; shift ;;
		--verbose) VERBOSE=1; shift ;;
		-h|--help) usage 0 ;;
		*) echo "unknown option: $1" >&2; usage 1 ;;
	esac
done

REPO=$(cd "$(dirname "$0")/.." 2>/dev/null || exit 1; pwd)
[ -n "$OUT" ] || OUT="$REPO/out"
IMAGE="ghcr.io/openwrt/sdk:$ARCH-$BRANCH"
VOL_DL="zapret-sdk-dl-$BRANCH"
VOL_FEEDS="zapret-sdk-feeds-$ARCH-$BRANCH"

# ---------------------------------------------------------------- preflight

if ! command -v docker >/dev/null 2>&1; then
	cat >&2 <<'EOF'
error: docker not found.

On macOS the lightest option is colima (no Docker Desktop licence needed):

    brew install colima docker
    colima start --cpu 4 --memory 8 --disk 60

An OpenWrt SDK build wants roughly 8 GB of RAM and 20+ GB of disk. On Apple
Silicon the SDK image is linux/amd64 only, so it runs under emulation - expect
the first build to take a while.
EOF
	exit 1
fi

if ! docker info >/dev/null 2>&1; then
	echo "error: the docker daemon is not reachable (try: colima start)" >&2
	exit 1
fi

if [ "$CLEAN" = "1" ]; then
	echo "==> removing cached volumes"
	docker volume rm -f "$VOL_DL" "$VOL_FEEDS" >/dev/null 2>&1 || true
fi

PLATFORM=
case "$(uname -m)" in
	arm64|aarch64)
		PLATFORM="--platform linux/amd64"
		echo "note: $(uname -m) host, the SDK image is linux/amd64 - running under emulation"
		;;
esac

mkdir -p "$OUT"

echo "==> image  : $IMAGE"
echo "==> source : $REPO (working tree)"
echo "==> output : $OUT"

# ---------------------------------------------------------------- build

MAKE_V=
[ "$VERBOSE" = "1" ] && MAKE_V="V=sc"

# shellcheck disable=SC2086
docker run --rm -i $PLATFORM --user root \
	-v "$REPO":/src:ro \
	-v "$OUT":/out \
	-v "$VOL_DL":/builder/dl \
	-v "$VOL_FEEDS":/builder/feeds \
	-e MAKE_V="$MAKE_V" \
	"$IMAGE" sh -s <<'INNER'
set -e
SDKDIR=/builder
REPO_NAME=zapret-openwrt
cd $SDKDIR

echo "==> fixing SDK paths"
mkdir -p $SDKDIR/shared-workdir
rm -rf $SDKDIR/shared-workdir/build
ln -sf $SDKDIR $SDKDIR/shared-workdir/build

echo "==> importing the package sources"
rm -rf ./package/$REPO_NAME
mkdir -p ./package/$REPO_NAME
# .git is a worktree pointer here and /src is read-only; neither belongs in the build
tar -C /src --exclude=./.git --exclude=./out --exclude=./.claude -cf - . \
	| tar -C ./package/$REPO_NAME -xf -
echo "    presets: $( ls -1 ./package/$REPO_NAME/zapret/presets/*.conf 2>/dev/null | wc -l )"
echo "    payloads: $( ls -1 ./package/$REPO_NAME/zapret/files/fake/flowseal/*.bin 2>/dev/null | wc -l )"

echo "==> feeds"
[ -f feeds.conf ] || mv feeds.conf.default feeds.conf
sed -i -e 's|base.*\.git|base https://github.com/openwrt/openwrt.git|' feeds.conf
sed -i -e 's|packages.*\.git|packages https://github.com/openwrt/packages.git|' feeds.conf
sed -i -e 's|luci.*\.git|luci https://github.com/openwrt/luci.git|' feeds.conf
./scripts/feeds update base packages luci
./scripts/feeds install -a

echo "==> config"
make defconfig
# keep the LuCI sources readable in the package - makes on-router debugging sane
sed -i 's/CONFIG_LUCI_JSMIN=y/CONFIG_LUCI_JSMIN=n/g' .config
sed -i 's/CONFIG_LUCI_CSSTIDY=y/CONFIG_LUCI_CSSTIDY=n/g' .config
grep -q '^CONFIG_LUCI_CSSTIDY=' .config || echo 'CONFIG_LUCI_CSSTIDY=n' >> .config

echo "==> compiling"
make package/$REPO_NAME/zapret/compile \
     package/$REPO_NAME/luci-app-zapret/compile \
     -j"$(nproc)" $MAKE_V

echo "==> collecting"
rm -f /out/*.ipk /out/*.apk
find ./bin/packages/*/base -type f -regex ".*zapret.*\.[ai]pk$" -exec cp -v {} /out/ \;

echo "==> verifying package contents"
PKG=$( ls -1 /out/zapret_*.ipk /out/zapret_*.apk 2>/dev/null | head -n1 )
[ -n "$PKG" ] || { echo "FAIL: no zapret package produced"; exit 1; }
rm -rf /tmp/x && mkdir -p /tmp/x
tar -xzf "$PKG" -C /tmp/x
if [ -f /tmp/x/data.tar.gz ]; then
	tar -tzf /tmp/x/data.tar.gz > /tmp/list.txt     # ipk
else
	find /tmp/x -type f > /tmp/list.txt             # apk
fi
echo "    presets in package : $( grep -c 'opt/zapret/presets/.*\.conf' /tmp/list.txt || true )"
echo "    payloads in package: $( grep -c 'opt/zapret/files/fake/flowseal/.*\.bin' /tmp/list.txt || true )"
for want in \
	'opt/zapret/presets/general\.conf' \
	'opt/zapret/files/fake/flowseal/stun\.bin' \
	'opt/zapret/ipset/zapret-hosts-flowseal\.txt'; do
	grep -q "$want" /tmp/list.txt || { echo "FAIL: $want missing from the package"; exit 1; }
done
echo "    OK"
chmod 644 /out/* 2>/dev/null || true
INNER

echo
echo "==> built:"
ls -lh "$OUT"
cat <<EOF

Install on the router:

    scp $OUT/*.ipk root@192.168.1.1:/tmp/
    ssh root@192.168.1.1 'opkg install --force-reinstall /tmp/zapret_*.ipk /tmp/luci-app-zapret_*.ipk'

Then hard-refresh LuCI (Ctrl+Shift+R) and open
Services -> Zapret -> Settings -> NFQWS options.
EOF

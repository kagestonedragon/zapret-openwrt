#!/bin/sh
# Copyright (c) 2026 zapret-openwrt
#
# Push the preset feature onto a running router without rebuilding the package.
# Everything this touches is interpreted (JS / shell) or plain data, so no toolchain
# is involved. The router must already have a matching zapret + luci-app-zapret installed.
#
#   ./tools/deploy-dev.sh root@192.168.1.1
#
# Re-run it after every edit; it is idempotent.

set -e

TARGET="$1"
if [ -z "$TARGET" ]; then
	echo "usage: $0 [user@]host" >&2
	exit 1
fi

REPO=$(cd "$(dirname "$0")/.." 2>/dev/null || exit 1; pwd)
cd "$REPO"

for f in luci-app-zapret/htdocs/luci-static/resources/view/zapret/presets.js \
         luci-app-zapret/htdocs/luci-static/resources/view/zapret/lists.js \
         zapret/update-lists.sh zapret/presets/general.conf; do
	[ -f "$f" ] || { echo "error: $f not found - run from a full checkout" >&2; exit 1; }
done

echo "==> packing"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/www/luci-static/resources/view/zapret"
mkdir -p "$STAGE/usr/share/rpcd/acl.d"
mkdir -p "$STAGE/usr/share/luci/menu.d"
mkdir -p "$STAGE/opt/zapret/presets/user"
mkdir -p "$STAGE/opt/zapret/files/fake/flowseal"
mkdir -p "$STAGE/opt/zapret/ipset"

cp luci-app-zapret/htdocs/luci-static/resources/view/zapret/*.js  "$STAGE/www/luci-static/resources/view/zapret/"
cp luci-app-zapret/htdocs/luci-static/resources/view/zapret/*.css "$STAGE/www/luci-static/resources/view/zapret/"
cp luci-app-zapret/root/usr/share/rpcd/acl.d/*.json               "$STAGE/usr/share/rpcd/acl.d/"
cp luci-app-zapret/root/usr/share/luci/menu.d/*.json              "$STAGE/usr/share/luci/menu.d/"

cp zapret/comfunc.sh zapret/def-cfg.sh zapret/uci-def-cfg.sh      "$STAGE/opt/zapret/"
cp zapret/update-lists.sh zapret/restore-def-cfg.sh               "$STAGE/opt/zapret/"
cp zapret/presets/*.conf                                          "$STAGE/opt/zapret/presets/"
cp zapret/files/fake/flowseal/*.bin                               "$STAGE/opt/zapret/files/fake/flowseal/"
cp zapret/ipset/zapret-hosts-flowseal.txt                         "$STAGE/opt/zapret/ipset/"
cp zapret/ipset/zapret-hosts-flowseal-exclude.txt                 "$STAGE/opt/zapret/ipset/"

find "$STAGE/opt/zapret/presets" "$STAGE/opt/zapret/files" "$STAGE/opt/zapret/ipset" -type f -exec chmod 644 {} +
chmod 755 "$STAGE/opt/zapret/"*.sh
chmod 644 "$STAGE/www/luci-static/resources/view/zapret/"* "$STAGE/usr/share/rpcd/acl.d/"* "$STAGE/usr/share/luci/menu.d/"*

echo "==> copying to $TARGET"
# tar over ssh: works with plain dropbear, no scp/sftp server needed on the router
tar -C "$STAGE" -cf - . | ssh "$TARGET" 'tar -C / -xf -'

echo "==> refreshing"
ssh "$TARGET" 'sh -s' <<'REMOTE'
set -e
mkdir -p /opt/zapret/presets/user
# pull the new uci options (GAME_FILTER, IPSET_MODE, FAKE_*) into /etc/config/zapret
[ -x /opt/zapret/renew-cfg.sh ] && /opt/zapret/renew-cfg.sh
# keep the host-list cron task in sync with the uci config
[ -x /opt/zapret/update-lists.sh ] && /opt/zapret/update-lists.sh -S >/dev/null 2>&1
# LuCI caches its module index and compiled views aggressively
rm -f /tmp/luci-index*
rm -rf /tmp/luci-modulecache/
/etc/init.d/rpcd reload
[ -x /sbin/luci-reload ] && /sbin/luci-reload
[ -x /etc/init.d/uhttpd ] && /etc/init.d/uhttpd reload
echo "presets on router: $(ls -1 /opt/zapret/presets/*.conf 2>/dev/null | wc -l)"
echo "payloads on router: $(ls -1 /opt/zapret/files/fake/flowseal/*.bin 2>/dev/null | wc -l)"
echo "update-lists.sh:    $([ -x /opt/zapret/update-lists.sh ] && echo installed || echo MISSING)"
REMOTE

echo
echo "done. open LuCI -> Services -> Zapret -> Strategies"
echo "                        and Services -> Zapret -> Host lists"
echo "and HARD-refresh the browser (Ctrl+Shift+R) - LuCI caches the JS."

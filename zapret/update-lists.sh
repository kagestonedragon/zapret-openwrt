#!/bin/sh
# Copyright (c) 2026 remittor

EXE_DIR=$(cd "$(dirname "$0")" 2>/dev/null || exit 1; pwd)
[ -f "$EXE_DIR/comfunc.sh" ] || { echo "ERROR: file $EXE_DIR/comfunc.sh not found!"; exit 1; }
. $EXE_DIR/comfunc.sh
. /lib/functions.sh

IPSET_DIR="$ZAPRET_BASE/ipset"
# staging dir must live on the same fs as the lists, so that mv is an atomic rename
TMP_DIR="$ZAPRET_BASE/ipset/.tmp"
LIST_SEC_TYPE="userlist"
CRON_TAG="#$ZAPRET_CFG_NAME-lists"
CRON_PARAM="LISTS_CRON"
CURL_TIMEOUT=90
CURL_HEADER1="Cache-Control: no-cache, no-store, must-revalidate"
MAX_LIST_SIZE=33554432

opt_all=
opt_section=
opt_cron=
opt_cron_sync=

while getopts "as:cS" opt; do
	case $opt in
		a) opt_all=true;;
		s) opt_section="$OPTARG";;
		c) opt_cron=true; opt_all=true;;
		S) opt_cron_sync=true;;
	esac
done

ZAP_TOTAL=0
ZAP_UPDATED=0
ZAP_FAILED=0
ZAP_AUTO_CNT=0

function pkg_mgr_update
{
	if command -v apk >/dev/null 2>&1; then
		apk update
	else
		opkg update
	fi
}

function curl_prepare
{
	local info
	if ! command -v curl >/dev/null 2>&1; then
		pkg_mgr_update >/dev/null 2>&1
		echo ">>> Package curl not found, installing..."
		if command -v apk >/dev/null 2>&1; then
			apk add curl
		else
			opkg install curl
		fi
	fi
	if ! command -v curl >/dev/null 2>&1; then
		echo "ERROR: Required package \"curl\" not installed!"
		return 10
	fi
	info=$( curl -V )
	if ! echo "$info" | grep -q 'https'; then
		echo "ERROR: package \"curl\" not supported HTTPS protocol!"
		echo "NOTE: Please install package \"curl-ssl\""
		return 11
	fi
	return 0
}

# reject path traversal and any attempt to hijack files outside the ipset dir
function check_fname
{
	local fn="$1"
	[ -z "$fn" ] && return 1
	case "$fn" in
		*/*|*..*) return 1;;
	esac
	echo "$fn" | grep -qE '^[A-Za-z0-9][A-Za-z0-9._-]*\.txt$' || return 1
	# managed by nfqws itself, must not be overwritten
	[ "$fn" = "zapret-hosts-auto.txt" ] && return 1
	return 0
}

function check_url
{
	case "$1" in
		https://*|http://*) return 0;;
	esac
	return 1
}

# guard against HTML error pages, binary junk and truncated downloads
function check_content
{
	local fn="$1"
	local type="$2"
	local sz1 sz2 good
	if [ ! -s "$fn" ]; then
		echo "  ERROR: downloaded file is empty"
		return 1
	fi
	if head -c 512 "$fn" | grep -qiE '<!doctype|<html|<head>'; then
		echo "  ERROR: downloaded file is a HTML page, not a list"
		return 1
	fi
	sz1=$( head -c 65536 "$fn" | wc -c )
	sz2=$( head -c 65536 "$fn" | tr -d '\000' | wc -c )
	if [ "$sz1" != "$sz2" ]; then
		echo "  ERROR: downloaded file contains binary data"
		return 1
	fi
	if [ "$type" = "ipset" ]; then
		good=$( grep -cE '^[[:space:]]*[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+(/[0-9]{1,2})?[[:space:]]*$|^[[:space:]]*[0-9a-fA-F:]+:[0-9a-fA-F:]*(/[0-9]{1,3})?[[:space:]]*$' "$fn" )
	else
		good=$( grep -cE '^[[:space:]]*\^?[A-Za-z0-9*_-]+(\.[A-Za-z0-9*_-]+)*[[:space:]]*$' "$fn" )
	fi
	if [ "${good:-0}" -lt 1 ]; then
		echo "  ERROR: no valid \"$type\" entries found in downloaded file"
		return 1
	fi
	return 0
}

function download_list
{
	local sec="$1"
	local name file url type enabled autoupdate
	local dst tmp status rc sz lines

	config_get name       "$sec" name       "$sec"
	config_get file       "$sec" file       ""
	config_get url        "$sec" url        ""
	config_get type       "$sec" type       "hostlist"
	config_get_bool enabled    "$sec" enabled    1
	config_get_bool autoupdate "$sec" autoupdate 0

	[ -n "$opt_section" ] && [ "$opt_section" != "$sec" ] && return 0
	[ "$opt_cron" = "true" ] && [ "$autoupdate" != "1" ] && return 0

	ZAP_TOTAL=$(( ZAP_TOTAL + 1 ))
	echo "--- $name [$sec]"

	if [ "$enabled" != "1" ]; then
		echo "  SKIP: list is disabled"
		return 0
	fi
	if ! check_fname "$file"; then
		echo "  ERROR: incorrect file name: '$file'"
		ZAP_FAILED=$(( ZAP_FAILED + 1 ))
		return 0
	fi
	if [ -z "$url" ]; then
		echo "  SKIP: source URL is not specified (local list)"
		return 0
	fi
	if ! check_url "$url"; then
		echo "  ERROR: unsupported URL: $url"
		ZAP_FAILED=$(( ZAP_FAILED + 1 ))
		return 0
	fi

	dst="$IPSET_DIR/$file"
	tmp="$TMP_DIR/$file.tmp"
	rm -f "$tmp"
	echo "  GET $url"
	status=$( curl -s -L --retry 3 --retry-delay 1 --retry-max-time 60 \
	               --max-time $CURL_TIMEOUT --max-filesize $MAX_LIST_SIZE \
	               -H "$CURL_HEADER1" -w '%{http_code}' -o "$tmp" "$url" 2>/dev/null )
	rc=$?
	if [ $rc != 0 ] || [ "$status" != "200" ]; then
		echo "  ERROR: download failed (curl rc = $rc, http status = $status)"
		rm -f "$tmp"
		ZAP_FAILED=$(( ZAP_FAILED + 1 ))
		return 0
	fi
	if ! check_content "$tmp" "$type"; then
		rm -f "$tmp"
		ZAP_FAILED=$(( ZAP_FAILED + 1 ))
		return 0
	fi

	sz=$( wc -c < "$tmp" )
	lines=$( grep -cve '^[[:space:]]*$' "$tmp" )
	if [ -f "$dst" ] && cmp -s "$tmp" "$dst"; then
		echo "  OK: no changes (size = $sz, entries = $lines)"
		rm -f "$tmp"
		return 0
	fi
	[ -f "$dst" ] && cp -f "$dst" "$dst.bak"
	chmod 644 "$tmp"
	if ! mv -f "$tmp" "$dst"; then
		echo "  ERROR: cannot install list into $dst"
		rm -f "$tmp"
		ZAP_FAILED=$(( ZAP_FAILED + 1 ))
		return 0
	fi
	echo "  UPDATED: $dst (size = $sz, entries = $lines)"
	ZAP_UPDATED=$(( ZAP_UPDATED + 1 ))
	return 0
}

function count_autoupdate
{
	local sec="$1"
	local enabled autoupdate url
	config_get url "$sec" url ""
	config_get_bool enabled    "$sec" enabled    1
	config_get_bool autoupdate "$sec" autoupdate 0
	[ "$enabled" = "1" ] && [ "$autoupdate" = "1" ] && [ -n "$url" ] && ZAP_AUTO_CNT=$(( ZAP_AUTO_CNT + 1 ))
	return 0
}

function remove_cron_task_lists
{
	[ ! -f $CRONTAB_FILE ] && return 0
	if grep -q -e "$CRON_TAG" $CRONTAB_FILE; then
		sed -i "/$CRON_TAG/d" $CRONTAB_FILE
	fi
	return 0
}

function cron_sync
{
	local sched="$( uci -q get $ZAPRET_CFG_SEC.$CRON_PARAM )"
	local cur new_task=""

	ZAP_AUTO_CNT=0
	config_foreach count_autoupdate $LIST_SEC_TYPE
	if [ $ZAP_AUTO_CNT -gt 0 ] && [ -n "$sched" ]; then
		# 5 cron fields, digits and the usual separators only
		if ! echo "$sched" | grep -qE '^[0-9*/,-]+([[:space:]]+[0-9*/,-]+){4}$'; then
			echo "ERROR: incorrect cron schedule: '$sched'"
			return 12
		fi
		new_task="$sched $ZAPRET_BASE/update-lists.sh -c >/dev/null 2>&1 $CRON_TAG"
	fi
	cur="$( grep -e "$CRON_TAG" $CRONTAB_FILE 2>/dev/null )"
	if [ "$cur" = "$new_task" ]; then
		return 0	# nothing to do, do not touch the cron daemon
	fi
	remove_cron_task_lists
	if [ -n "$new_task" ]; then
		[ ! -f $CRONTAB_FILE ] && touch $CRONTAB_FILE
		echo "$new_task" >> $CRONTAB_FILE
		echo "Cron task installed: $sched ($ZAP_AUTO_CNT list(s))"
	else
		echo "Cron task removed"
	fi
	/etc/init.d/cron restart 2>/dev/null
	return 0
}

config_load $ZAPRET_CFG_NAME

if [ "$opt_cron_sync" = "true" ]; then
	cron_sync
	exit $?
fi

if [ -z "$opt_all" ] && [ -z "$opt_section" ]; then
	echo "Usage: update-lists.sh [-a] [-c] [-s <section>] [-S]"
	echo "  -a            update all enabled lists"
	echo "  -c            update lists marked for auto-update (cron mode)"
	echo "  -s <section>  update single list"
	echo "  -S            sync cron task with current config"
	exit 2
fi

mkdir -p "$IPSET_DIR" "$TMP_DIR"
curl_prepare || exit $?

config_foreach download_list $LIST_SEC_TYPE

if [ $ZAP_TOTAL = 0 ]; then
	if [ -n "$opt_section" ]; then
		echo "ERROR: list '$opt_section' not found"
		ZAP_FAILED=1
	else
		echo "No lists configured for update"
	fi
fi

if [ $ZAP_UPDATED -gt 0 ]; then
	# nfqws/tpws re-read all lists on SIGHUP, no service restart needed
	killall -HUP nfqws 2>/dev/null && echo "Daemon nfqws reloaded lists (SIGHUP)"
	killall -HUP tpws  2>/dev/null && echo "Daemon tpws reloaded lists (SIGHUP)"
	[ "$opt_cron" = "true" ] && logger -p notice -t $ZAP_LOG_TAG "update-lists: $ZAP_UPDATED list(s) updated"
fi

rm -rf "$TMP_DIR"

# keep cron in sync on manual runs; never touch the cron daemon from inside cron
[ "$opt_cron" != "true" ] && [ -z "$opt_section" ] && cron_sync

echo "RESULT: total = $ZAP_TOTAL, updated = $ZAP_UPDATED, failed = $ZAP_FAILED"
[ $ZAP_FAILED -gt 0 ] && exit 1
exit 0

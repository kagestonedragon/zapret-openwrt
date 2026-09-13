# tools

Developer-side helpers. Nothing here is installed on the router.

## flowseal2preset.py

Converts the Windows presets of
[Flowseal/zapret-discord-youtube](https://github.com/Flowseal/zapret-discord-youtube)
into the preset format the LuCI "Strategies" tab reads.

```sh
git clone https://github.com/Flowseal/zapret-discord-youtube ../zapret-discord-youtube
./tools/flowseal2preset.py ../zapret-discord-youtube
```

It writes, and the result is committed:

| output | installed to | conffile? |
|---|---|---|
| `zapret/presets/*.conf` | `/opt/zapret/presets/` | no — refreshed on upgrade |
| `zapret/files/fake/flowseal/*.bin` | `/opt/zapret/files/fake/flowseal/` | no |

The host and IP lists are not part of the output, see below.

`--check` writes nothing and exits non-zero if the committed tree is stale, which is what a
CI job would run.

### What the conversion does

* Drops the `.bat` boilerplate and joins the `^`-continued `winws.exe` argument list,
  undoing cmd's caret escaping (`^!` → `!`).
* `--wf-tcp` / `--wf-udp` are WinDivert-only. They have no nfqws counterpart, so their ports
  move out of the strategy body into the preset's `PORTS_TCP` / `PORTS_UDP` metadata, which
  the GUI writes to `NFQWS_PORTS_TCP` / `NFQWS_PORTS_UDP`.
* The lists Flowseal maintains are not copied. `%LISTS%list-general.txt`, `list-google.txt`,
  `list-exclude.txt`, `ipset-exclude.txt` and `ipset-all.txt` become placeholders, filled in
  with the files of the matching entries on the Host lists tab, which downloads them from the
  same repository. The `*-user` lists hold the user's own entries and map onto zapret's
  `zapret-hosts-user.txt`, `zapret-hosts-user-exclude.txt` and `zapret-ip-user-exclude.txt`.
* `%BIN%…` payloads are remapped onto `/opt/zapret/files/fake/flowseal/…`.

  The `flowseal/` namespace is deliberate: this repo already ships a
  `files/fake/tls_clienthello_max_ru.bin` whose contents **differ** from the Windows file of
  the same name. A flat copy would silently resolve to the wrong payload — nfqws would start
  cleanly and the strategy would just underperform.
* The settings that are runtime-tunable on Windows become placeholders resolved by the GUI
  when a preset is applied:

  | placeholder | resolved from | Windows counterpart |
  |---|---|---|
  | `<GF_TCP>` `<GF_UDP>` | `GAME_FILTER` | `%GameFilterTCP%` / `%GameFilterUDP%` |
  | `<IPSET>` | `IPSET_MODE` (`none` / `any` / `loaded`) and the Host lists entry `fs_ipset_all` | the `lists/ipset-all.txt` tri-state |
  | `<LIST_GENERAL>` `<LIST_GOOGLE>` `<LIST_EXCLUDE>` `<IPSET_EXCLUDE>` | Host lists entries `fs_general`, `fs_google`, `fs_exclude`, `fs_ipset_exclude` | `lists/list-general.txt`, `list-google.txt`, `list-exclude.txt`, `ipset-exclude.txt` |
  | `<FAKE_DISCORD>` | `FAKE_DISCORD_UDP` | `bin/ACTIVE_DISCORD_UDP.bin` |
  | `<FAKE_GAME>` | `FAKE_GAME_UDP` | `bin/ACTIVE_GAME_UDP.bin` |

  Placeholders never reach `NFQWS_OPT` — upstream zapret only expands `<HOSTLIST>` and
  `<HOSTLIST_NOAUTO>` itself and would hand anything else to nfqws verbatim.

  The game filter and the IPSet filter behave as `service.bat` sets them up. A game filter
  part that is on puts its port range into the strategy and into `NFQWS_PORTS_*`, whatever
  the IPSet filter says; one that is off drops its section (Windows keeps it on port 12).
  `loaded` points `--ipset=` at the `fs_ipset_all` list, `any` drops the option (no include
  ipset means every address, as the empty file does on Windows), and `none` swaps it for
  `--ipset-ip=203.0.113.113/32`, the address `service.bat` writes into `ipset-all.txt`.

  A preset is not applied while a list file it names is missing, or while all include lists
  of a section are empty: nfqws does not start without the file, and a profile whose include
  lists are all empty applies to everything.
* Output is constrained to one `--option` per line and rejects `"` `` ` `` `$` `&` `\`,
  because `/opt/zapret/config` is sourced as root and rewritten with `sed`, and
  `is_valid_config` does not catch the resulting corruption.

## build-docker.sh

Builds `zapret` and `luci-app-zapret` locally in the official OpenWrt SDK container.
Builds the **working tree**, so uncommitted changes are included.

```sh
./tools/build-docker.sh                                  # aarch64_cortex-a53, ipk (24.10)
./tools/build-docker.sh --arch x86_64 --branch v23.05.5
./tools/build-docker.sh --clean                          # drop the cached feeds/downloads
```

The SDK branch decides the package format and must match the release on the router:
`v23.05.x` and `v24.10.x` produce **ipk**, `v25.12.x` and `SNAPSHOT` produce **apk**.
Packages land in `out/`.

Feeds and downloads are cached in named Docker volumes (`zapret-sdk-dl-*`,
`zapret-sdk-feeds-*`), so only the first build pays for cloning the feeds.

After building, the script unpacks the result and fails if the presets or the fake payloads
did not make it in — a broken install rule should not produce a package that merely looks
fine.

`.github/workflows/build-dev.yml` runs the same thing on GitHub Actions when you would
rather not build locally. (The release workflow, `build.yml`, always checks out
`remittor/zapret-openwrt`, so it cannot build your branch.)

## test-presets.js

Offline tests for the rendering logic in
`luci-app-zapret/htdocs/luci-static/resources/view/zapret/presets.js`. No browser needed:

```sh
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc tools/test-presets.js
```

Any JS shell providing `readFile()` and `print()` works. The suite renders every shipped
preset under every combination of the extra settings and asserts that no placeholder leaks,
no forbidden character appears, and no empty or dangling `--new` section is produced.

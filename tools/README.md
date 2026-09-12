# tools

Developer-side helpers. Nothing here is installed on the router.

## flowseal2preset.py

Converts the Windows presets of
[Flowseal/zapret-discord-youtube](https://github.com/Flowseal/zapret-discord-youtube)
into the preset format the LuCI "NFQWS options" tab reads.

```sh
git clone https://github.com/Flowseal/zapret-discord-youtube ../zapret-discord-youtube
./tools/flowseal2preset.py ../zapret-discord-youtube
```

It writes, and the result is committed:

| output | installed to | conffile? |
|---|---|---|
| `zapret/presets/*.conf` | `/opt/zapret/presets/` | no — refreshed on upgrade |
| `zapret/files/fake/flowseal/*.bin` | `/opt/zapret/files/fake/flowseal/` | no |
| `zapret/ipset/zapret-hosts-flowseal*.txt` | `/opt/zapret/ipset/` | no |

`--check` writes nothing and exits non-zero if the committed tree is stale, which is what a
CI job would run.

### What the conversion does

* Drops the `.bat` boilerplate and joins the `^`-continued `winws.exe` argument list,
  undoing cmd's caret escaping (`^!` → `!`).
* `--wf-tcp` / `--wf-udp` are WinDivert-only. They have no nfqws counterpart, so their ports
  move out of the strategy body into the preset's `PORTS_TCP` / `PORTS_UDP` metadata, which
  the GUI writes to `NFQWS_PORTS_TCP` / `NFQWS_PORTS_UDP`.
* `%LISTS%…` paths are remapped onto `/opt/zapret/ipset/…`; the two vendor lists Flowseal
  maintains are copied into the package.
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
  | `<IPSET>` | `IPSET_MODE` | the `lists/ipset-all.txt` tri-state |
  | `<FAKE_DISCORD>` | `FAKE_DISCORD_UDP` | `bin/ACTIVE_DISCORD_UDP.bin` |
  | `<FAKE_GAME>` | `FAKE_GAME_UDP` | `bin/ACTIVE_GAME_UDP.bin` |

  Placeholders never reach `NFQWS_OPT` — upstream zapret only expands `<HOSTLIST>` and
  `<HOSTLIST_NOAUTO>` itself and would hand anything else to nfqws verbatim. A section whose
  feature is switched off is dropped rather than neutralised.
* Output is constrained to one `--option` per line and rejects `"` `` ` `` `$` `&` `\`,
  because `/opt/zapret/config` is sourced as root and rewritten with `sed`, and
  `is_valid_config` does not catch the resulting corruption.

## test-presets.js

Offline tests for the rendering logic in
`luci-app-zapret/htdocs/luci-static/resources/view/zapret/presets.js`. No browser needed:

```sh
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc tools/test-presets.js
```

Any JS shell providing `readFile()` and `print()` works. The suite renders every shipped
preset under every combination of the extra settings and asserts that no placeholder leaks,
no forbidden character appears, and no empty or dangling `--new` section is produced.

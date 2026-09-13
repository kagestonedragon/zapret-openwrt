#!/usr/bin/env python3
# Copyright (c) 2026 zapret-openwrt
#
# Offline converter: Flowseal's "zapret-discord-youtube" Windows presets  ->  zapret-openwrt presets.
#
# Run it on the developer machine against a checkout of
# https://github.com/Flowseal/zapret-discord-youtube and commit the result.
#
#   ./tools/flowseal2preset.py ../zapret-discord-youtube
#
# Output:
#   zapret/presets/*.conf              converted presets (package data, refreshed on upgrade)
#   zapret/files/fake/flowseal/*.bin   fake payloads, Windows basenames kept verbatim
#
# The host and IP lists are not copied: the presets name them by placeholder, and LuCI fills
# in the files of the Host lists tab, which downloads them from the same repository.
#
# The payloads live in their own "flowseal/" namespace on purpose: zapret-openwrt already
# ships a file called tls_clienthello_max_ru.bin whose contents differ from the Windows file
# of the same name, and a flat copy would silently resolve to the wrong payload.

import argparse
import glob
import os
import re
import shutil
import sys

# ----------------------------------------------------------------------------- constants

FAKE_SUBDIR = 'flowseal'
FAKE_DIR = '/opt/zapret/files/fake/' + FAKE_SUBDIR
IPSET_DIR = '/opt/zapret/ipset'

# %LISTS%<name>  ->  placeholder resolved by the GUI at apply time, or on-router path.
# The lists Flowseal maintains become placeholders for the files of the matching Host lists
# entries. The *-user lists hold the user's own entries and map onto zapret's files for that.
LIST_MAP = {
    'list-general.txt':       '<LIST_GENERAL>',
    'list-google.txt':        '<LIST_GOOGLE>',
    'list-exclude.txt':       '<LIST_EXCLUDE>',
    'ipset-exclude.txt':      '<IPSET_EXCLUDE>',
    'ipset-all.txt':          '<IPSET>',
    'list-general-user.txt':  IPSET_DIR + '/zapret-hosts-user.txt',
    'list-exclude-user.txt':  IPSET_DIR + '/zapret-hosts-user-exclude.txt',
    'ipset-exclude-user.txt': IPSET_DIR + '/zapret-ip-user-exclude.txt',
}

# %BIN%<name> -> placeholder, for the two mutable "active fake" slots of service.bat.
ACTIVE_FAKE_MAP = {
    'ACTIVE_DISCORD_UDP.bin': '<FAKE_DISCORD>',
    'ACTIVE_GAME_UDP.bin':    '<FAKE_GAME>',
}

# service.bat ships ACTIVE_DISCORD_UDP.bin / ACTIVE_GAME_UDP.bin as byte copies of these
# (established by hash, not documented upstream). They become the GUI defaults.
ACTIVE_FAKE_DEFAULTS = {
    '<FAKE_DISCORD>': 'quic_initial_steamcommunity_com.bin',
    '<FAKE_GAME>':    'quic_initial_4pda_to.bin',
}

GAMEFILTER_MAP = {
    '%GameFilterTCP%': '<GF_TCP>',
    '%GameFilterUDP%': '<GF_UDP>',
}

# WinDivert-only capture filter; has no nfqws counterpart. Its role is played by
# NFQWS_PORTS_TCP / NFQWS_PORTS_UDP, so it is lifted out of the body into metadata.
WF_OPTS = ('--wf-tcp=', '--wf-udp=')

# /opt/zapret/config is sourced as root and rewritten with sed; these characters either
# execute, corrupt the config, or are rejected by the LuCI editor.
FORBIDDEN = '"`$&\\'


# ----------------------------------------------------------------------------- .bat parsing

def read_cmdline(path):
    """Return the winws argument string from a general*.bat, continuations joined."""
    with open(path, 'r', encoding='utf-8-sig', errors='replace') as fh:
        lines = fh.read().splitlines()

    start = None
    for idx, line in enumerate(lines):
        if 'winws.exe' in line and line.lstrip().lower().startswith('start '):
            start = idx
            break
    if start is None:
        raise ValueError('no "start ... winws.exe" line found')

    chunks = []
    idx = start
    while idx < len(lines):
        line = lines[idx].rstrip()
        if line.endswith('^'):
            chunks.append(line[:-1])
            idx += 1
            continue
        chunks.append(line)
        break
    cmd = ' '.join(chunks)

    # drop everything up to and including the winws.exe invocation
    cut = cmd.find('winws.exe"')
    if cut < 0:
        raise ValueError('cannot locate end of winws.exe token')
    return cmd[cut + len('winws.exe"'):].strip()


def unescape_cmd(text):
    """cmd.exe caret escaping: ^! ^& ^| ^^ ... -> the bare character."""
    return re.sub(r'\^(.)', r'\1', text)


def tokenize(cmdline):
    """Split on whitespace, honouring double quotes (which are path delimiters here)."""
    tokens, buf, quoted = [], [], False
    for ch in cmdline:
        if ch == '"':
            quoted = not quoted
            continue
        if ch.isspace() and not quoted:
            if buf:
                tokens.append(''.join(buf))
                buf = []
            continue
        buf.append(ch)
    if buf:
        tokens.append(''.join(buf))
    return tokens


# ----------------------------------------------------------------------------- translation

def translate_value(value, used_fakes, src_name):
    """Rewrite one option value from Windows form to on-router form."""
    for win_var, placeholder in GAMEFILTER_MAP.items():
        value = value.replace(win_var, placeholder)

    if value.startswith('%BIN%'):
        name = value[len('%BIN%'):]
        if name in ACTIVE_FAKE_MAP:
            return ACTIVE_FAKE_MAP[name]
        used_fakes.add(name)
        return FAKE_DIR + '/' + name

    if value.startswith('%LISTS%'):
        name = value[len('%LISTS%'):]
        if name not in LIST_MAP:
            raise ValueError('%s: unknown list file %r' % (src_name, name))
        return LIST_MAP[name]

    if '%' in value:
        raise ValueError('%s: unresolved cmd variable in %r' % (src_name, value))
    return value


def translate(tokens, src_name):
    """-> (body_lines, ports_tcp, ports_udp, used_fake_basenames)"""
    ports = {'--wf-tcp=': None, '--wf-udp=': None}
    used_fakes = set()
    body = []

    for token in tokens:
        handled = False
        for opt in WF_OPTS:
            if token.startswith(opt):
                # "80,443,...,%GameFilterTCP%" -> base ports; the game range is appended
                # by the GUI, so the placeholder is dropped here.
                parts = [p for p in token[len(opt):].split(',')
                         if p and not p.startswith('%')]
                ports[opt] = ','.join(parts)
                handled = True
                break
        if handled:
            continue

        if '=' in token:
            key, _, value = token.partition('=')
            token = key + '=' + translate_value(value, used_fakes, src_name)
        else:
            token = translate_value(token, used_fakes, src_name)
        body.append(token)

    if ports['--wf-tcp='] is None or ports['--wf-udp='] is None:
        raise ValueError('%s: missing --wf-tcp/--wf-udp' % src_name)
    return body, ports['--wf-tcp='], ports['--wf-udp='], used_fakes


def layout(body, comment):
    """One option per line; --new starts a section, blank line between sections."""
    lines = ['--comment=' + comment]
    for token in body:
        if token == '--new':
            lines.append('--new')
            lines.append('')
        else:
            lines.append(token)
    while lines and lines[-1] == '':
        lines.pop()
    # --new must lead its section, not trail the previous one
    out = []
    for line in lines:
        if line == '--new' and out and out[-1] == '':
            out.pop()
            out.append('')
        out.append(line)
    return out


# ----------------------------------------------------------------------------- naming

def preset_id(filename):
    """'general (FAKE TLS AUTO ALT2).bat' -> 'general_FAKE_TLS_AUTO_ALT2'"""
    base = os.path.splitext(os.path.basename(filename))[0]
    ident = re.sub(r'[^A-Za-z0-9]+', '_', base).strip('_')
    if not re.match(r'^[A-Za-z0-9_.-]{1,64}$', ident):
        raise ValueError('cannot derive a safe id from %r' % filename)
    return ident


def display_name(filename):
    return os.path.splitext(os.path.basename(filename))[0]


# ----------------------------------------------------------------------------- emit

def render_preset(src, version):
    name = display_name(src)
    ident = preset_id(src)
    cmdline = unescape_cmd(read_cmdline(src))
    tokens = tokenize(cmdline)
    body, ptcp, pudp, used_fakes = translate(tokens, os.path.basename(src))

    for line in body:
        bad = [ch for ch in FORBIDDEN if ch in line]
        if bad:
            raise ValueError('%s: forbidden character(s) %r in %r' % (name, bad, line))

    text = [
        '# generated by tools/flowseal2preset.py - do not edit',
        '# source: zapret-discord-youtube %s / %s' % (version, os.path.basename(src)),
        'NAME=' + name,
        'SOURCE=flowseal/' + os.path.basename(src),
        'VERSION=' + version,
        'PORTS_TCP=' + ptcp,
        'PORTS_UDP=' + pudp,
        '[OPT]',
    ]
    text.extend(layout(body, 'preset_' + ident))
    return ident, '\n'.join(text) + '\n', used_fakes


def read_version(win_root):
    path = os.path.join(win_root, 'service.bat')
    try:
        with open(path, 'r', encoding='utf-8-sig', errors='replace') as fh:
            for line in fh:
                m = re.match(r'\s*set\s+"LOCAL_VERSION=([^"]+)"', line)
                if m:
                    return m.group(1).strip()
    except OSError:
        pass
    return 'unknown'


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('win_root', help='path to a zapret-discord-youtube checkout')
    ap.add_argument('--repo', default=os.path.join(os.path.dirname(__file__), '..'),
                    help='path to the zapret-openwrt repo (default: parent of tools/)')
    ap.add_argument('--check', action='store_true',
                    help='do not write; fail if the committed output would change')
    args = ap.parse_args()

    win_root = os.path.abspath(args.win_root)
    repo = os.path.abspath(args.repo)
    if not os.path.isdir(os.path.join(win_root, 'bin')):
        sys.exit('error: %s does not look like a zapret-discord-youtube checkout' % win_root)

    version = read_version(win_root)
    presets_dir = os.path.join(repo, 'zapret', 'presets')
    fake_dir = os.path.join(repo, 'zapret', 'files', 'fake', FAKE_SUBDIR)

    sources = sorted(glob.glob(os.path.join(win_root, 'general*.bat')))
    if not sources:
        sys.exit('error: no general*.bat found in %s' % win_root)

    rendered, all_fakes, failed = {}, set(), []
    for src in sources:
        try:
            ident, text, used = render_preset(src, version)
        except ValueError as exc:
            failed.append(str(exc))
            continue
        if ident in rendered:
            failed.append('duplicate preset id %r' % ident)
            continue
        rendered[ident] = text
        all_fakes |= used

    if failed:
        for msg in failed:
            print('error: ' + msg, file=sys.stderr)
        sys.exit(1)

    # Every *.bin service.bat offers as an "active fake" candidate must ship too, so the
    # GUI's fake-substitution dropdown has something to point at.
    for path in sorted(glob.glob(os.path.join(win_root, 'bin', '*.bin'))):
        base = os.path.basename(path)
        if not base.startswith('ACTIVE_'):
            all_fakes.add(base)

    changed = []

    def emit(path, data, binary=False):
        mode = 'rb' if binary else 'r'
        try:
            with open(path, mode) as fh:
                if fh.read() == data:
                    return
        except OSError:
            pass
        changed.append(os.path.relpath(path, repo))
        if args.check:
            return
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb' if binary else 'w') as fh:
            fh.write(data)

    for ident, text in sorted(rendered.items()):
        emit(os.path.join(presets_dir, ident + '.conf'), text)

    for base in sorted(all_fakes):
        src = os.path.join(win_root, 'bin', base)
        if not os.path.isfile(src):
            sys.exit('error: referenced payload %s is missing from %s/bin' % (base, win_root))
        with open(src, 'rb') as fh:
            emit(os.path.join(fake_dir, base), fh.read(), binary=True)

    # stale presets from a previous run (upstream renamed or dropped a .bat)
    for path in sorted(glob.glob(os.path.join(presets_dir, '*.conf'))):
        if os.path.splitext(os.path.basename(path))[0] not in rendered:
            changed.append(os.path.relpath(path, repo) + ' (removed)')
            if not args.check:
                os.remove(path)

    print('%d presets, %d payloads  (upstream %s)'
          % (len(rendered), len(all_fakes), version))
    for name in ACTIVE_FAKE_DEFAULTS.values():
        if name not in all_fakes:
            print('warning: default active fake %s was not shipped' % name, file=sys.stderr)

    if args.check and changed:
        print('error: committed output is stale, re-run without --check:', file=sys.stderr)
        for name in changed:
            print('  ' + name, file=sys.stderr)
        sys.exit(1)
    if changed:
        print('updated %d file(s)' % len(changed))
    else:
        print('already up to date')


if __name__ == '__main__':
    main()

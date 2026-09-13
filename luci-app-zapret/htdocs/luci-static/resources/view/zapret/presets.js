'use strict';
'require baseclass';
'require fs';
'require uci';
'require view.zapret.env as env_tools';

/*
 * Strategy presets for the Strategies tab.
 *
 * A preset file is metadata lines, then a '[OPT]' marker, then the strategy body
 * (one --option per line, blank line between --new sections):
 *
 *     NAME=general (ALT11)
 *     PORTS_TCP=80,443,2053,2083,2087,2096,8443
 *     PORTS_UDP=443,19294-19344,50000-50100
 *     [OPT]
 *     --comment=preset_general_ALT11
 *     --filter-udp=443
 *     ...
 *
 * The body may carry placeholders that the filters of the tab resolve when it is saved.
 * They never reach NFQWS_OPT - what gets stored in uci is always fully rendered text,
 * because upstream zapret only expands <HOSTLIST> and <HOSTLIST_NOAUTO> itself and would
 * hand anything else to nfqws verbatim.
 *
 *     <GF_TCP> / <GF_UDP>   game filter port range
 *     <IPSET>               ipset-all, switched by the IPSet filter: none / any / loaded
 *     <LIST_GENERAL>        list-general.txt  \
 *     <LIST_GOOGLE>         list-google.txt    |  files of the matching lists
 *     <LIST_EXCLUDE>        list-exclude.txt   |  on the Host lists tab
 *     <IPSET_EXCLUDE>       ipset-exclude.txt /
 *     <FAKE_DISCORD>        Discord/STUN UDP fake payload
 *     <FAKE_GAME>           unknown-UDP (game traffic) fake payload
 */

const GAME_PORTS = '1024-65535';

/* what service.bat writes into ipset-all.txt for "none": an address nothing is sent to */
const NO_MATCH_IP = '203.0.113.113/32';

/* list placeholder -> section of the Host lists entry it is taken from (env.listCatalog) */
const LIST_ROLES = {
    LIST_GENERAL:  'fs_general',
    LIST_GOOGLE:   'fs_google',
    LIST_EXCLUDE:  'fs_exclude',
    IPSET_EXCLUDE: 'fs_ipset_exclude',
    IPSET:         'fs_ipset_all',
};

/* files the package shipped before the Flowseal lists moved to Host lists; presets saved
   by the user back then still name them */
const LEGACY_PATHS = {
    '/opt/zapret/ipset/zapret-hosts-flowseal.txt':         '<LIST_GENERAL>',
    '/opt/zapret/ipset/zapret-hosts-flowseal-exclude.txt': '<LIST_EXCLUDE>',
};

// /opt/zapret/config is sourced as root and rewritten with sed. A quote splits the shell
// string, '&' expands to the whole match in the sed replacement, '$' and '`' execute.
// None of them are caught by is_valid_config, so they must be refused here.
const FORBIDDEN_RE = /["`$&\\]/;

// the only markers upstream zapret expands on its own
const NATIVE_MARKERS = [ 'HOSTLIST', 'HOSTLIST_NOAUTO' ];

// the ones a preset file may carry on top of them
const TEMPLATE_MARKERS = [ 'GF_TCP', 'GF_UDP', 'FAKE_DISCORD', 'FAKE_GAME' ].concat(Object.keys(LIST_ROLES));

return baseclass.extend({
    __init__: function() {
        env_tools.load_env(this);
    },

    /* filter values of a config the Strategies tab has not saved yet, as def-cfg.sh sets them */
    defaults: {
        game:    'off',
        ipset:   'none',
        fakeDsc: 'quic_initial_steamcommunity_com.bin',
        fakeGam: 'quic_initial_4pda_to.bin',
    },

    /* ------------------------------------------------------------------ preset files */

    /* '<dir>/<id>.conf' -> id; bundled presets are listed before user ones */
    listPresets: function() {
        let scan = (dir, user) => L.resolveDefault(fs.list(dir), []).then(entries => {
            return (entries || [])
                .filter(e => e.type == 'file' && e.name.endsWith('.conf'))
                .map(e => ({
                    id: e.name.slice(0, -5),
                    user: user,
                    path: dir + '/' + e.name,
                }));
        });
        return Promise.all([
            scan(this.presetsDir, false),
            scan(this.presetsUserDir, true),
        ]).then(([ bundled, mine ]) => {
            let cmp = (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true });
            return bundled.sort(cmp).concat(mine.sort(cmp));
        });
    },

    listFakeFiles: function() {
        return L.resolveDefault(fs.list(this.fakeNsDir), []).then(entries => {
            return (entries || [])
                .filter(e => e.type == 'file' && e.name.endsWith('.bin'))
                .map(e => e.name)
                .sort();
        });
    },

    /* name -> size of the files in the lists dir */
    listListFiles: function() {
        return L.resolveDefault(fs.list(this.ipsetDir), []).then(entries => {
            let out = { };
            (entries || []).forEach(e => {
                if (e.type == 'file') {
                    out[e.name] = e.size;
                }
            });
            return out;
        });
    },

    readPreset: function(item) {
        return fs.read(item.path).then(text => {
            let parsed = this.parse(text || '');
            parsed.body = this.upgradeBody(parsed.body);
            parsed.id = item.id;
            parsed.user = item.user;
            parsed.path = item.path;
            return parsed;
        });
    },

    /* what the Strategies tab works with: { presets (read in), fakes, files (lists dir) } */
    loadCatalog: function() {
        return Promise.all([ this.listPresets(), this.listFakeFiles(), this.listListFiles() ])
            .then(([ items, fakes, files ]) => {
                return Promise.all(items.map(item => L.resolveDefault(this.readPreset(item), null)))
                    .then(presets => ({
                        presets: presets.filter(p => p != null),
                        fakes: fakes,
                        files: files,
                    }));
            });
    },

    parse: function(text) {
        let meta = { }, body = [ ], in_body = false;
        let lines = text.replace(/\r/g, '').split('\n');
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            if (in_body) {
                body.push(line);
                continue;
            }
            if (line.trim() == '[OPT]') {
                in_body = true;
                continue;
            }
            if (line.trim() == '' || line.startsWith('#')) {
                continue;
            }
            let eq = line.indexOf('=');
            if (eq > 0) {
                meta[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
            }
        }
        return { meta: meta, body: body.join('\n').trim() };
    },

    upgradeBody: function(body) {
        for (let path in LEGACY_PATHS) {
            body = body.split(path).join(LEGACY_PATHS[path]);
        }
        return body;
    },

    format: function(meta, body) {
        let out = [ ];
        let order = [ 'NAME', 'SOURCE', 'VERSION', 'PORTS_TCP', 'PORTS_UDP' ];
        for (let i = 0; i < order.length; i++) {
            if (meta[order[i]] != null && meta[order[i]] !== '') {
                out.push(order[i] + '=' + meta[order[i]]);
            }
        }
        out.push('[OPT]');
        out.push(body.trim());
        return out.join('\n') + '\n';
    },

    /* ------------------------------------------------------------------ rendering */

    /* split the body on '--new' lines; blank separator lines are cosmetic */
    sections: function(body) {
        let out = [ [ ] ];
        let lines = body.replace(/\r/g, '').split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim() == '--new') {
                out.push([ ]);
                continue;
            }
            out[out.length - 1].push(lines[i]);
        }
        return out;
    },

    /*
     * Resolve the placeholders the way service.bat sets them up before starting winws.
     *
     * Game filter: a part that is on gets the port range, whatever the IPSet filter says.
     * A part that is off drops its section; Windows keeps it on port 12, which nothing uses.
     *
     * IPSet filter, the three states of ipset-all.txt:
     *   loaded  the ipset-all list from Host lists
     *   any     no include ipset, which nfqws takes as every address (an empty file on Windows)
     *   none    an address nothing is sent to, so those sections match nothing
     *
     * lists: placeholder -> { path }, see resolveLists()
     */
    render: function(body, knobs, lists) {
        let tcp_on = (knobs.game == 'all' || knobs.game == 'tcp');
        let udp_on = (knobs.game == 'all' || knobs.game == 'udp');
        let loaded = (knobs.ipset == 'loaded');
        let ipset_opt = /(^|\s)--ipset=<IPSET>(?=\s|$)/g;
        let ipset_to = loaded ? '--ipset=<IPSET>'
                     : (knobs.ipset == 'any') ? ''
                     : '--ipset-ip=' + NO_MATCH_IP;

        let kept = this.sections(body).filter(lines => {
            let text = lines.join('\n');
            if (!tcp_on && text.indexOf('<GF_TCP>') >= 0) return false;
            if (!udp_on && text.indexOf('<GF_UDP>') >= 0) return false;
            return true;
        }).map(lines => lines.map(line => {
            let out = line.replace(ipset_opt, (m, pre) => pre + ipset_to);
            /* a line that held nothing but a dropped option goes with it */
            return (out.trim() == '' && line.trim() != '') ? null : out;
        }).filter(line => line !== null).join('\n').trim()).filter(text => text.length > 0);

        let out = kept.join('\n\n--new\n\n');
        out = out.replace(/<GF_TCP>/g, GAME_PORTS);
        out = out.replace(/<GF_UDP>/g, GAME_PORTS);
        for (let ph in (lists || { })) {
            /* left in place otherwise, for validateBody() to refuse */
            if (ph != 'IPSET' || loaded) {
                out = out.split('<' + ph + '>').join(lists[ph].path);
            }
        }
        out = out.replace(/<FAKE_DISCORD>/g, this.fakeNsDir + '/' + knobs.fakeDsc);
        out = out.replace(/<FAKE_GAME>/g, this.fakeNsDir + '/' + knobs.fakeGam);
        return out;
    },

    renderPorts: function(meta, knobs) {
        let add = (base, on) => {
            base = (base || '').trim();
            if (!on) return base;
            return base ? base + ',' + GAME_PORTS : GAME_PORTS;
        };
        return {
            tcp: add(meta.PORTS_TCP, knobs.game == 'all' || knobs.game == 'tcp'),
            udp: add(meta.PORTS_UDP, knobs.game == 'all' || knobs.game == 'udp'),
        };
    },

    /* ------------------------------------------------------------------ validation */

    /* rendered text, as it goes into NFQWS_OPT */
    validateBody: function(text) {
        if (!text || !text.trim()) {
            return _('Strategy is empty');
        }
        let bad = text.match(FORBIDDEN_RE);
        if (bad) {
            return _('Strategy cannot contain the character %s').format('"' + bad[0] + '"');
        }
        let markers = text.match(/<([A-Z_]+)>/g) || [ ];
        for (let i = 0; i < markers.length; i++) {
            let name = markers[i].slice(1, -1);
            if (NATIVE_MARKERS.indexOf(name) < 0) {
                return _('Unresolved placeholder %s').format(markers[i]);
            }
        }
        return null;
    },

    /* the body of a preset file, which may still carry the placeholders */
    validateTemplate: function(text) {
        if (!text || !text.trim()) {
            return _('Strategy is empty');
        }
        let bad = text.match(FORBIDDEN_RE);
        if (bad) {
            return _('Strategy cannot contain the character %s').format('"' + bad[0] + '"');
        }
        let markers = text.match(/<([A-Z_]+)>/g) || [ ];
        for (let i = 0; i < markers.length; i++) {
            let name = markers[i].slice(1, -1);
            if (NATIVE_MARKERS.indexOf(name) < 0 && TEMPLATE_MARKERS.indexOf(name) < 0) {
                return _('Unknown placeholder %s').format(markers[i]);
            }
        }
        return null;
    },

    /* ports and port ranges, comma separated; empty is allowed */
    validatePorts: function(text) {
        if (!text) {
            return null;
        }
        let ok = /^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(text) && text.split(',').every(part => {
            let [ lo, hi ] = part.split('-').map(Number);
            return lo >= 1 && lo <= 65535 && (hi == null || (hi >= lo && hi <= 65535));
        });
        return ok ? null : _('Ports must be a comma separated list of ports and ranges, for example %s').format('443,50000-50100');
    },

    validateName: function(name) {
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name || '')) {
            return _('Name may contain only letters, digits, "_", "-", "." (max 64 characters)');
        }
        if (name == '.' || name == '..') {
            return _('Invalid name');
        }
        return null;
    },

    /* ------------------------------------------------------------------ host lists */

    /*
     * placeholder -> { name, file, path, added } for every list a preset can name.
     * The entry is found by the section name the Host lists catalog gives it, or by its
     * URL for a row added before catalog entries had fixed names. One that is not added
     * still resolves to the catalog file name; listProblems() is what keeps a strategy
     * naming it from being saved.
     */
    resolveLists: function() {
        let out = { };
        for (let ph in LIST_ROLES) {
            let item = this.listCatalog.filter(i => i.sid == LIST_ROLES[ph])[0];
            let by_name = null, by_url = null;
            uci.sections(this.appName, this.userListSecType, s => {
                if (s['.name'] == item.sid) {
                    by_name = s;
                } else if (!by_url && s.url == item.url) {
                    by_url = s;
                }
            });
            let sec = by_name || by_url;
            let file = (sec && sec.file) || item.file;
            out[ph] = { name: item.name, file: file, path: this.ipsetDir + '/' + file, added: !!sec };
        }
        return out;
    },

    /*
     * Why a rendered strategy would not work, one message per list file.
     * nfqws does not start when a list file is missing, and a profile whose include
     * hostlists (or ipsets) are all empty matches every host (or address), so a strategy
     * naming a list that has not been downloaded would either stop zapret or desync
     * everything. Only the files in the lists dir can be checked.
     *
     * files: name -> size, see listListFiles()
     */
    listProblems: function(text, lists, files) {
        let dir = this.ipsetDir + '/';
        let known = { };
        for (let ph in lists) {
            known[lists[ph].path] = lists[ph];
        }
        let title = path => known[path] ? '%s (%s)'.format(known[path].name, known[path].file) : path;
        let problems = [ ], seen = { };
        let report = (path, msg) => {
            if (!seen[path]) {
                seen[path] = true;
                problems.push(msg);
            }
        };

        this.sections(text).forEach(lines => {
            let include = { hostlist: [ ], ipset: [ ] };
            let inline = { hostlist: false, ipset: false };
            lines.join(' ').split(/\s+/).forEach(tok => {
                let m = tok.match(/^--(hostlist|ipset)(-exclude)?=(.+)$/);
                if (!m) {
                    if (/^--hostlist-domains=./.test(tok)) inline.hostlist = true;
                    if (/^--ipset-ip=./.test(tok))         inline.ipset = true;
                    return;
                }
                let path = m[3];
                if (path.indexOf(dir) != 0) {
                    if (!m[2]) inline[m[1]] = true;    /* cannot be checked, trust it */
                    return;
                }
                let size = files[path.slice(dir.length)];
                if (size == null) {
                    report(path, !known[path]       ? _('%s does not exist').format(title(path))
                               : known[path].added ? _('%s has not been downloaded yet').format(title(path))
                               : _('%s is not added on the Host lists tab').format(title(path)));
                } else if (!m[2]) {
                    include[m[1]].push({ path: path, size: size });
                }
            });
            for (let kind in include) {
                if (!inline[kind] && include[kind].length && include[kind].every(f => !f.size)) {
                    include[kind].forEach(f => report(f.path, _('%s is empty, so its section would apply to everything').format(title(f.path))));
                }
            }
        });
        return problems;
    },

    /* ------------------------------------------------------------------ saving */

    /*
     * Stores the choices of the Strategies tab together with the strategy rendered from them,
     * NFQWS_OPT and the port lists. It runs as the save callback of the tab, before uci.save,
     * and stores nothing when the strategy would not work: the save stops with the reason and
     * uci still holds what the tab was loaded with. Without a chosen preset, or when its file
     * is gone, only the choices are stored.
     *
     * presets: as loadCatalog() returns them; knobs: { preset, game, ipset, fakeDsc, fakeGam }
     */
    stage: function(presets, knobs) {
        let item = presets.filter(p => p.id == knobs.preset)[0];
        if (!item) {
            this.storeKnobs(knobs);
            return Promise.resolve(false);
        }
        return this.listListFiles().then(files => {
            let lists = this.resolveLists();
            let opt = this.render(item.body, knobs, lists);
            let problems = [ this.validateBody(opt) ].filter(err => err)
                .concat(this.listProblems(opt, lists, files));
            if (problems.length) {
                throw new Error(_('Strategy "%s" cannot be applied:').format(item.meta.NAME || item.id)
                                + '\n- ' + problems.join('\n- '));
            }
            let N = (this.appName == 'zapret2') ? 'NFQWS2' : 'NFQWS';
            let ports = this.renderPorts(item.meta, knobs);
            this.storeKnobs(knobs);
            this.setIfChanged(N + '_OPT', '\n' + opt.trim() + '\n');
            this.setIfChanged(N + '_PORTS_TCP', ports.tcp);
            this.setIfChanged(N + '_PORTS_UDP', ports.udp);
            return true;
        });
    },

    storeKnobs: function(knobs) {
        this.setIfChanged('NFQWS_PRESET', knobs.preset || null);
        [ [ 'GAME_FILTER',      knobs.game ],
          [ 'IPSET_MODE',       knobs.ipset ],
          [ 'FAKE_DISCORD_UDP', knobs.fakeDsc ],
          [ 'FAKE_GAME_UDP',    knobs.fakeGam ] ].forEach(([ opt, value ]) => {
            if (value) {
                this.setIfChanged(opt, value);
            }
        });
    },

    /* uci.set records a change even for the value already stored, and that would need applying */
    setIfChanged: function(opt, value) {
        if (uci.get(this.appName, 'config', opt) !== value) {
            uci.set(this.appName, 'config', opt, value);
        }
    },

    /* ------------------------------------------------------------------ writing */

    writeFile: function(path, data) {
        let dir = path.slice(0, path.lastIndexOf('/'));
        let tmp = path + '.tmp';
        let quoted = data.replace(/'/g, `'"'"'`);
        /* the dir can be missing on a router upgraded from a package that predates presets */
        let cmd = `mkdir -p '${dir}' && printf %s '${quoted}' > '${tmp}'`
                + ` && chmod 644 '${tmp}' && mv -f '${tmp}' '${path}'`;
        return fs.exec('/bin/busybox', [ 'sh', '-c', cmd ]).then(res => {
            if (res.code !== 0) {
                throw new Error('write failed, rc = ' + res.code);
            }
            return true;
        });
    },

    removeFile: function(path) {
        return fs.exec('/bin/busybox', [ 'rm', '-f', path ]).then(res => {
            if (res.code !== 0) {
                throw new Error('remove failed, rc = ' + res.code);
            }
            return true;
        });
    },

    savePreset: function(name, meta, body) {
        let err = this.validateName(name) || this.validateTemplate(body)
               || this.validatePorts(meta.PORTS_TCP) || this.validatePorts(meta.PORTS_UDP);
        if (err) {
            return Promise.reject(new Error(err));
        }
        let copy = Object.assign({ }, meta, { NAME: meta.NAME || name });
        return this.writeFile(this.presetsUserDir + '/' + name + '.conf',
                              this.format(copy, body));
    },
});

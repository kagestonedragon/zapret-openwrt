'use strict';
'require baseclass';
'require fs';
'require ui';
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
 * The body may carry placeholders that the "extra settings" resolve at apply time.
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

return baseclass.extend({
    __init__: function() {
        env_tools.load_env(this);
    },

    /* ------------------------------------------------------------------ uci option names */

    /* the zapret2 flavour renames every nfqws option; presets are flavour agnostic */
    optName: function(base) {
        return (this.appName == 'zapret2') ? base.replace(/^NFQWS_/, 'NFQWS2_') : base;
    },

    getKnobs: function() {
        let get = (k, dflt) => uci.get(this.appName, 'config', k) || dflt;
        return {
            preset:  get('NFQWS_PRESET', ''),
            game:    get('GAME_FILTER', 'off'),
            ipset:   get('IPSET_MODE', 'none'),
            fakeDsc: get('FAKE_DISCORD_UDP', 'quic_initial_steamcommunity_com.bin'),
            fakeGam: get('FAKE_GAME_UDP', 'quic_initial_4pda_to.bin'),
        };
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
                return _('Unresolved placeholder %h').format(markers[i]);
            }
        }
        return null;
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

    /* presets using --dpi-desync-fooling=ts silently degrade without TCP timestamps */
    needsTcpTimestamps: function(text) {
        return /--dpi-desync-fooling=[a-z,]*\bts\b/.test(text || '');
    },

    /* ------------------------------------------------------------------ host lists */

    /*
     * placeholder -> { name, file, path, added } for every list a preset can name.
     * The entry is found by the section name the Host lists catalog gives it, or by its
     * URL for a row added before catalog entries had fixed names. One that is not added
     * still resolves to the catalog file name, so that the preview reads right;
     * listProblems() is what keeps such a strategy from being applied.
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
        let title = path => known[path] ? '%h (%h)'.format(known[path].name, known[path].file)
                                        : '%h'.format(path);
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
        let err = this.validateName(name) || this.validateBody(body);
        if (err) {
            return Promise.reject(new Error(err));
        }
        let copy = Object.assign({ }, meta, { NAME: meta.NAME || name });
        return this.writeFile(this.presetsUserDir + '/' + name + '.conf',
                              this.format(copy, body));
    },

    /* ------------------------------------------------------------------ the dialog */

    dialog: baseclass.extend({
        __init__: function(opts = { }) {
            Object.assign(this, {
                ctx: null,        /* the presets module itself */
                onApply: null,    /* callback({ opt, ports, knobs, id, name }) */
            }, opts);
            this.items = [ ];
            this.fakes = [ ];
            this.files = { };     /* lists dir: name -> size */
            this.lists = { };     /* see resolveLists() */
            this.cur = null;      /* { meta, body, id, user } */
            this.template = '';   /* body as edited by the user, placeholders intact */
            this.preview = true;
        },

        el: function(id) {
            return document.getElementById(id);
        },

        knobs: function() {
            return {
                preset:  this.cur ? this.cur.id : '',
                game:    this.el('zp_game').value,
                ipset:   this.el('zp_ipset').value,
                fakeDsc: this.el('zp_fdsc').value,
                fakeGam: this.el('zp_fgam').value,
            };
        },

        /* the editable template, picked up from the textarea when it is not in preview mode */
        currentTemplate: function() {
            if (!this.preview) {
                this.template = this.el('zp_body').value;
            }
            return this.template;
        },

        load: function() {
            let ctx = this.ctx;
            let saved = ctx.getKnobs();
            return Promise.all([ ctx.listPresets(), ctx.listFakeFiles(), ctx.listListFiles() ])
                .then(([ items, fakes, files ]) => {
                    this.items = items;
                    this.fakes = fakes;
                    this.files = files;
                    this.lists = ctx.resolveLists();
                    this.saved = saved;
                    let want = items.filter(i => i.id == saved.preset);
                    let pick = want.length ? want[0] : items[0];
                    if (!pick) {
                        return null;
                    }
                    return ctx.readPreset(pick).then(p => {
                        this.cur = p;
                        this.template = p.body;
                        return p;
                    });
                });
        },

        refresh: function() {
            let ctx = this.ctx;
            let body = this.el('zp_body');
            if (!this.cur) {
                return;
            }
            let knobs = this.knobs();
            let template = this.currentTemplate();
            let rendered = ctx.render(template, knobs, this.lists);
            if (this.preview) {
                body.value = rendered;
                body.readOnly = true;
                body.classList.add('zp-readonly');
            } else {
                body.value = template;
                body.readOnly = false;
                body.classList.remove('zp-readonly');
            }
            let ports = ctx.renderPorts(this.cur.meta, knobs);
            let notes = [ ];
            notes.push('%s: <code>%s</code>'.format(_('TCP ports'), ports.tcp || '-'));
            notes.push('%s: <code>%s</code>'.format(_('UDP ports'), ports.udp || '-'));
            if (ctx.needsTcpTimestamps(template)) {
                /* the fooling shifts the timestamp in the client's own packets, so it is the
                   devices behind the router that have to send one, not the router */
                notes.push('⚠ ' + _('This strategy uses --dpi-desync-fooling=ts, which only works for devices that send TCP timestamps. Windows does not by default: run %s there, as service.bat does.')
                                    .format('<code>netsh interface tcp set global timestamps=enabled</code>'));
            }
            if (knobs.game != 'off') {
                notes.push('⚠ ' + _('Game filter queues ports %s to nfqws - this is a heavy load for a router')
                                    .format('<code>' + GAME_PORTS + '</code>'));
            }
            if (/--ipset=<IPSET>/.test(template)) {
                if (knobs.ipset == 'none' && knobs.game != 'off') {
                    notes.push('⚠ ' + _('IPSet filter "none": the sections filtered by ipset-all, the game ones too, match no address, the same as on Windows. Choose "loaded" to bypass the addresses of the list.'));
                }
                if (knobs.ipset == 'any') {
                    notes.push('⚠ ' + _('IPSet filter "any": the sections filtered by ipset-all apply to every address, which breaks many sites. Do not leave it on for long.'));
                }
            }
            let problems = ctx.listProblems(rendered, this.lists, this.files);
            if (problems.length) {
                notes.push('⛔ ' + _('Cannot be applied yet') + ':<br />&nbsp;&nbsp;• ' + problems.join('<br />&nbsp;&nbsp;• ')
                    + '<br />' + _('Add the lists on the %s tab, press "Update all now" there and open this dialog again.')
                                    .format('<a href="%s">%s</a>'.format(L.url('admin/services/zapret/lists'), _('Host lists'))));
            }
            this.el('zp_info').innerHTML = notes.join('<br />');
            this.el('zp_del').disabled = !this.cur.user;
        },

        selectPreset: function(id) {
            let ctx = this.ctx;
            let want = this.items.filter(i => i.id == id);
            if (!want.length) {
                return Promise.resolve();
            }
            return ctx.readPreset(want[0]).then(p => {
                this.cur = p;
                this.template = p.body;
                this.refresh();
            }).catch(e => {
                ui.addNotification(null, E('p', _('Unable to read the contents') + ': %s'.format(e.message)));
            });
        },

        /* ---------------------------------------------------------- actions */

        handleApply: function() {
            let ctx = this.ctx;
            if (!this.cur) {
                return;
            }
            let knobs = this.knobs();
            let rendered = ctx.render(this.currentTemplate(), knobs, this.lists);
            let err = ctx.validateBody(rendered)
                   || ctx.listProblems(rendered, this.lists, this.files).join('; ');
            if (err) {
                ui.addNotification(null, E('p', _('Unable to apply the preset') + ': ' + err));
                return;
            }
            let ports = ctx.renderPorts(this.cur.meta, knobs);
            if (typeof(this.onApply) === 'function') {
                this.onApply({
                    opt: rendered,
                    ports: ports,
                    knobs: knobs,
                    id: this.cur.id,
                    name: this.cur.meta.NAME || this.cur.id,
                });
            }
            ui.hideModal();
        },

        handleSaveAs: function() {
            let ctx = this.ctx;
            if (!this.cur) {
                return;
            }
            let name = (this.el('zp_name').value || '').trim();
            let body = this.currentTemplate();
            let meta = Object.assign({ }, this.cur.meta, { NAME: name });
            return ctx.savePreset(name, meta, body).then(() => {
                return ctx.listPresets();
            }).then(items => {
                this.items = items;
                let sel = this.el('zp_pset');
                sel.innerHTML = '';
                this.fillPresetOptions(sel, name);
                this.el('zp_name').value = '';
                return this.selectPreset(name);
            }).then(() => {
                ui.addNotification(null, E('p', _('Preset "%s" saved.').format(name)), 'info');
            }).catch(e => {
                ui.addNotification(null, E('p', _('Unable to save the preset') + ': %s'.format(e.message)));
            });
        },

        handleDelete: function() {
            let ctx = this.ctx;
            if (!this.cur || !this.cur.user) {
                return;
            }
            let gone = this.cur.id;
            if (!confirm(_('Delete preset "%s"?').format(gone))) {
                return;
            }
            return ctx.removeFile(this.cur.path).then(() => {
                return ctx.listPresets();
            }).then(items => {
                this.items = items;
                let sel = this.el('zp_pset');
                sel.innerHTML = '';
                this.fillPresetOptions(sel, items.length ? items[0].id : null);
                return items.length ? this.selectPreset(items[0].id) : null;
            }).then(() => {
                ui.addNotification(null, E('p', _('Preset "%s" deleted.').format(gone)), 'info');
            }).catch(e => {
                ui.addNotification(null, E('p', _('Unable to delete the preset') + ': %s'.format(e.message)));
            });
        },

        /* ---------------------------------------------------------- rendering */

        fillPresetOptions: function(sel, selected) {
            let groups = [
                { label: _('Bundled presets'), user: false },
                { label: _('My presets'),      user: true  },
            ];
            for (let g = 0; g < groups.length; g++) {
                let list = this.items.filter(i => i.user === groups[g].user);
                if (!list.length) {
                    continue;
                }
                let grp = E('optgroup', { 'label': groups[g].label });
                for (let i = 0; i < list.length; i++) {
                    let attr = { 'value': list[i].id };
                    if (list[i].id === selected) {
                        attr.selected = 'selected';
                    }
                    grp.appendChild(E('option', attr, [ list[i].id ]));
                }
                sel.appendChild(grp);
            }
        },

        select: function(id, label, options, value) {
            let sel = E('select', { 'id': id, 'class': 'cbi-input-select' });
            for (let i = 0; i < options.length; i++) {
                let attr = { 'value': options[i][0] };
                if (options[i][0] === value) {
                    attr.selected = 'selected';
                }
                sel.appendChild(E('option', attr, [ options[i][1] ]));
            }
            sel.addEventListener('change', () => this.refresh());
            return E('div', { 'class': 'zp-knob' }, [ E('label', {}, label + ': '), sel ]);
        },

        render: function() {
            let saved = this.saved;
            let fakeOpts = this.fakes.map(n => [ n, n ]);
            if (!fakeOpts.length) {
                fakeOpts = [ [ saved.fakeDsc, saved.fakeDsc ] ];
            }

            let pset = E('select', { 'id': 'zp_pset', 'class': 'cbi-input-select' });
            this.fillPresetOptions(pset, this.cur ? this.cur.id : null);
            pset.addEventListener('change', ev => {
                this.template = '';
                this.selectPreset(ev.target.value);
            });

            let prev = E('input', { 'type': 'checkbox', 'id': 'zp_prev', 'checked': 'checked' });
            prev.addEventListener('change', ev => {
                /* edit -> preview: capture the edits before the rendered text overwrites them.
                   preview -> edit: the textarea holds rendered text, so keep the stored template. */
                if (ev.target.checked) {
                    this.template = this.el('zp_body').value;
                }
                this.preview = ev.target.checked;
                this.refresh();
            });

            let body = E('textarea', {
                'id': 'zp_body',
                'class': 'cbi-input-textarea',
                'style': 'width:100% !important',
                'rows': 20,
                'wrap': 'off',
                'spellcheck': 'false',
            });

            let del_btn = E('button', {
                'id': 'zp_del',
                'class': 'btn cbi-button-remove',
                'click': ui.createHandlerFn(this, this.handleDelete),
            }, _('Delete'));

            ui.showModal(_('Strategy presets'), [
                E('div', { 'class': 'cbi-section' }, [
                    E('div', { 'class': 'zp-row' }, [
                        E('label', {}, _('Preset') + ': '), pset, ' ',
                        E('label', {}, [ prev, ' ', _('show with substitutions applied') ]),
                    ]),
                    E('p', {}, body),
                    E('div', { 'class': 'cbi-section-descr' },
                        _('Uncheck the box above to edit the template. Placeholders &lt;GF_TCP&gt;, &lt;GF_UDP&gt;, &lt;IPSET&gt;, &lt;FAKE_DISCORD&gt;, &lt;FAKE_GAME&gt; are replaced by the settings below, &lt;LIST_GENERAL&gt;, &lt;LIST_GOOGLE&gt;, &lt;LIST_EXCLUDE&gt;, &lt;IPSET_EXCLUDE&gt; by the files of those lists on the Host lists tab; &lt;HOSTLIST&gt; is expanded by zapret itself.')),
                    E('hr'),
                    this.select('zp_game', _('Game filter'), [
                        [ 'off', _('disabled') ],
                        [ 'all', _('TCP and UDP') ],
                        [ 'tcp', _('TCP only') ],
                        [ 'udp', _('UDP only') ],
                    ], saved.game),
                    this.select('zp_ipset', _('IPSet filter'), [
                        [ 'none',   'none' ],
                        [ 'any',    'any' ],
                        [ 'loaded', 'loaded (' + this.lists.IPSET.file + ')' ],
                    ], saved.ipset),
                    this.select('zp_fdsc', _('Discord/STUN UDP fake'), fakeOpts, saved.fakeDsc),
                    this.select('zp_fgam', _('Game UDP fake'), fakeOpts, saved.fakeGam),
                    E('div', { 'id': 'zp_info', 'class': 'cbi-section-descr' }),
                ]),
                E('div', { 'style': 'display:flex; justify-content:space-between; align-items:center; gap:8px;' }, [
                    E('div', {}, [
                        E('input', {
                            'id': 'zp_name',
                            'type': 'text',
                            'class': 'cbi-input-text',
                            'placeholder': _('new preset name'),
                            'style': 'width:180px',
                        }), ' ',
                        E('button', {
                            'class': 'btn cbi-button-action',
                            'click': ui.createHandlerFn(this, this.handleSaveAs),
                        }, _('Save as')), ' ',
                        del_btn,
                    ]),
                    E('div', {}, [
                        E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Dismiss')), ' ',
                        E('button', {
                            'class': 'btn cbi-button-positive important',
                            'click': ui.createHandlerFn(this, this.handleApply),
                        }, _('Apply preset')),
                    ]),
                ]),
            ]);
            this.refresh();
        },

        show: function() {
            ui.showModal(null, E('p', { 'class': 'spinning' }, _('Loading')));
            return this.load().then(p => {
                ui.hideModal();
                if (!p) {
                    ui.addNotification(null, E('p', _('No presets found in %s').format(this.ctx.presetsDir)));
                    return;
                }
                return this.render();
            }).catch(e => {
                ui.hideModal();
                ui.addNotification(null, E('p', _('Unable to read the contents') + ': %s'.format(e.message)));
            });
        },
    }),
});


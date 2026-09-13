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
 *     <IPSET>               "bypass by IP" list
 *     <FAKE_DISCORD>        Discord/STUN UDP fake payload
 *     <FAKE_GAME>           unknown-UDP (game traffic) fake payload
 */

const GAME_PORTS = '1024-65535';

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

    readPreset: function(item) {
        return fs.read(item.path).then(text => {
            let parsed = this.parse(text || '');
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
     * Resolve the placeholders and drop the sections the extra settings switch off.
     * A section whose only purpose is a disabled feature is removed rather than
     * neutralised: on Windows those sections survive with an unused port number, which
     * is free there but pointless work for nfqws on a router.
     */
    render: function(body, knobs) {
        let tcp_on = (knobs.game == 'all' || knobs.game == 'tcp');
        let udp_on = (knobs.game == 'all' || knobs.game == 'udp');
        let ipset_on = (knobs.ipset != 'none');

        let kept = this.sections(body).filter(lines => {
            let text = lines.join('\n');
            if (!ipset_on && text.indexOf('<IPSET>') >= 0) return false;
            if (!tcp_on   && text.indexOf('<GF_TCP>') >= 0) return false;
            if (!udp_on   && text.indexOf('<GF_UDP>') >= 0) return false;
            return true;
        }).map(lines => lines.join('\n').trim()).filter(text => text.length > 0);

        let out = kept.join('\n\n--new\n\n');
        out = out.replace(/<GF_TCP>/g, GAME_PORTS);
        out = out.replace(/<GF_UDP>/g, GAME_PORTS);
        out = out.replace(/<IPSET>/g, this.iplstUserFN);
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
                return _('Unresolved placeholder %s').format(markers[i]);
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

    /*
     * In the Flowseal presets the game-filter sections also filter by the IP list, so with
     * the IP list off they are dropped and the game filter silently does nothing. Worth
     * saying out loud rather than leaving the user to wonder.
     */
    gameNeedsIpset: function(body) {
        return this.sections(body || '').some(lines => {
            let text = lines.join('\n');
            return text.indexOf('<GF_') >= 0 && text.indexOf('<IPSET>') >= 0;
        });
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
            return Promise.all([ ctx.listPresets(), ctx.listFakeFiles() ])
                .then(([ items, fakes ]) => {
                    this.items = items;
                    this.fakes = fakes;
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
            if (this.preview) {
                body.value = ctx.render(template, knobs);
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
                notes.push('⚠ ' + _('This strategy uses --dpi-desync-fooling=ts and needs %s')
                                    .format('<code>net.ipv4.tcp_timestamps=1</code>'));
            }
            if (knobs.game != 'off') {
                notes.push('⚠ ' + _('Game filter queues ports %s to nfqws - this is a heavy load for a router')
                                    .format('<code>' + GAME_PORTS + '</code>'));
                if (knobs.ipset == 'none' && ctx.gameNeedsIpset(template)) {
                    notes.push('⚠ ' + _('The game sections of this preset filter by the IP list. With the IP list disabled they are dropped and the game filter has no effect.'));
                }
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
            let rendered = ctx.render(this.currentTemplate(), knobs);
            let err = ctx.validateBody(rendered);
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
                        _('Uncheck the box above to edit the template. Placeholders &lt;GF_TCP&gt;, &lt;GF_UDP&gt;, &lt;IPSET&gt;, &lt;FAKE_DISCORD&gt;, &lt;FAKE_GAME&gt; are replaced by the settings below; &lt;HOSTLIST&gt; is expanded by zapret itself.')),
                    E('hr'),
                    this.select('zp_game', _('Game filter'), [
                        [ 'off', _('disabled') ],
                        [ 'all', _('TCP and UDP') ],
                        [ 'tcp', _('TCP only') ],
                        [ 'udp', _('UDP only') ],
                    ], saved.game),
                    this.select('zp_ipset', _('Bypass by IP list'), [
                        [ 'none', _('disabled') ],
                        [ 'user', _('User IP entries') + ' (' + this.ctx.iplstUserFN + ')' ],
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


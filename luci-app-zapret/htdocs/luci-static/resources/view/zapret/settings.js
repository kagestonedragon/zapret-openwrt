'use strict';
'require dom';
'require form';
'require uci';
'require ui';
'require view';
'require view.zapret.tools as tools';
'require view.zapret.presets as presets';

document.head.appendChild(E('link', {
    rel: 'stylesheet',
    href: L.resource('view/zapret/styles.css')
}));

/*
 * A set of buttons with one of them pressed; the value is the key of the pressed one.
 * groups: [ { title, choices: [ { key, label, hint } ] } ]
 */
const UIChips = ui.AbstractElement.extend({
    __init__: function(value, groups, options) {
        this.value = value;
        this.groups = groups;
        this.options = Object.assign({ }, options);
    },

    render: function() {
        let frame = E('div', {
            'id': this.options.id,
            'class': 'zp-chips' + (this.options.card ? ' zp-card' : ''),
        });
        this.groups.forEach(group => {
            if (!group.choices.length) {
                return;
            }
            if (group.title) {
                frame.appendChild(E('div', { 'class': 'zp-chip-title' }, [ group.title ]));
            }
            frame.appendChild(E('div', { 'class': 'zp-chip-group' }, group.choices.map(choice =>
                E('button', {
                    'type': 'button',
                    'class': 'zp-chip',
                    'title': choice.hint || null,
                    'data-value': choice.key,
                    'aria-pressed': (choice.key === this.value) ? 'true' : 'false',
                    'click': () => this.setValue(choice.key),
                }, [ choice.label ])
            )));
        });
        return this.bind(frame);
    },

    bind: function(frame) {
        this.node = frame;
        /* a chip sets the value first, the click then bubbles up here */
        this.setUpdateEvents(frame, 'click');
        this.setChangeEvents(frame, 'click');
        dom.bindClassInstance(frame, this);
        return frame;
    },

    getValue: function() {
        return this.value;
    },

    setValue: function(value) {
        this.value = value;
        this.node.querySelectorAll('.zp-chip').forEach(btn => {
            btn.setAttribute('aria-pressed', (btn.getAttribute('data-value') === value) ? 'true' : 'false');
        });
    },
});

/* the game filter as a checkbox per protocol; the value is off, all, tcp or udp, as service.bat keeps it */
const UIGameFilter = ui.AbstractElement.extend({
    __init__: function(value, options) {
        this.value = value;
        this.options = Object.assign({ }, options);
    },

    render: function() {
        let box = (proto, label) => {
            let widget = new ui.Checkbox((this.value == 'all' || this.value == proto) ? '1' : '0');
            let node = widget.render();
            return {
                widget: widget,
                node: E('span', { 'class': 'zp-check' }, [
                    node, E('label', { 'for': node.querySelector('input').id }, [ label ]),
                ]),
            };
        };
        this.tcp = box('tcp', 'TCP');
        this.udp = box('udp', 'UDP');
        return this.bind(E('div', { 'id': this.options.id, 'class': 'zp-game' }, [ this.tcp.node, this.udp.node ]));
    },

    bind: function(frame) {
        this.node = frame;
        this.setUpdateEvents(frame, 'change');
        this.setChangeEvents(frame, 'change');
        dom.bindClassInstance(frame, this);
        return frame;
    },

    getValue: function() {
        let tcp = this.tcp.widget.isChecked();
        let udp = this.udp.widget.isChecked();
        return (tcp && udp) ? 'all' : tcp ? 'tcp' : udp ? 'udp' : 'off';
    },

    setValue: function(value) {
        this.value = value;
        this.tcp.widget.setValue((value == 'all' || value == 'tcp') ? '1' : '0');
        this.udp.widget.setValue((value == 'all' || value == 'udp') ? '1' : '0');
    },
});

/*
 * Form options over the widgets above; groups() is called on every render. The parse of the
 * form leaves them out of uci: the save callback stores them together with the strategy they
 * render (presets.stage), so a refused save leaves nothing half written behind.
 */
const CBIChips = form.Value.extend({
    __name__: 'CBI.ZapretChips',

    write: function() { },
    remove: function() { },

    renderWidget: function(section_id, option_index, cfgvalue) {
        return new UIChips((cfgvalue != null) ? cfgvalue : this.default, this.groups(section_id), {
            id: this.cbid(section_id),
            card: this.card,
        }).render();
    },
});

const CBIGameFilter = form.Value.extend({
    __name__: 'CBI.ZapretGameFilter',

    write: function() { },
    remove: function() { },

    renderWidget: function(section_id, option_index, cfgvalue) {
        return new UIGameFilter((cfgvalue != null) ? cfgvalue : this.default, {
            id: this.cbid(section_id),
        }).render();
    },
});

/* the fake payloads come from a drop-down, stored the same way */
const CBIFakeList = form.ListValue.extend({
    __name__: 'CBI.ZapretFakeList',

    write: function() { },
    remove: function() { },
});

return view.extend({
    svc_info: null,
    map: null,
    catalog: null,      /* presets, fake payloads, lists dir: see presets.loadCatalog() */

    load: function()
    {
        return Promise.all([
            tools.baseLoad(this, (data) => {
                //console.log('SYS FEATURES: '+JSON.stringify(data.sys_feat));
                tools.load_feat_env();
                return data;
            }),
            L.resolveDefault(presets.loadCatalog(), null),
        ]).then(([ data, catalog ]) => {
            this.catalog = catalog || { presets: [ ], fakes: [ ], files: { } };
            return data;
        });
    },

    findPreset: function(id)
    {
        return this.catalog.presets.filter(p => p.id === id)[0] || null;
    },

    /* what an option of the tab holds right now, saved or not */
    formValue: function(name)
    {
        let found = this.map.lookupOption(name, 'config');
        return found ? found[0].formvalue('config') : null;
    },

    formKnobs: function()
    {
        return {
            preset:  this.formValue('NFQWS_PRESET'),
            game:    this.formValue('GAME_FILTER'),
            ipset:   this.formValue('IPSET_MODE'),
            fakeDsc: this.formValue('FAKE_DISCORD_UDP'),
            fakeGam: this.formValue('FAKE_GAME_UDP'),
        };
    },

    /* the Edit button and the list warning follow the strategy and filters picked on the tab */
    refreshStrategyUi: function()
    {
        let knobs = this.formKnobs();
        let item = this.findPreset(knobs.preset);
        let edit = this.map.findElement('id', 'zp_edit');
        if (edit) {
            edit.disabled = !(item && item.user);
        }
        let notice = this.map.findElement('id', 'zp_notice');
        if (!notice) {
            return;
        }
        let problems = [ ];
        if (item) {
            let lists = presets.resolveLists();
            problems = presets.listProblems(presets.render(item.body, knobs, lists), lists, this.catalog.files);
        }
        dom.content(notice, problems.length ? [
            E('div', { }, [ _('This strategy needs lists that are not ready yet:') ]),
            E('ul', { }, problems.map(p => E('li', { }, [ p ]))),
            E('div', { }, [
                E('a', { 'href': L.url('admin/services/zapret/lists') }, [ _('Host lists') ]),
                ': ', _('add them and press "Update all now".'),
            ]),
        ] : [ ]);
        notice.hidden = (problems.length == 0);
    },

    /* options are cached when the form loads, so a changed uci needs a load before the render */
    rerender: function()
    {
        return this.map.load()
            .then(() => this.map.renderContents())
            .then(() => this.refreshStrategyUi());
    },

    /* re-read the presets after the editor changed them; what is picked but not saved stays */
    reloadStrategies: async function(select_id, removed_id)
    {
        let knobs = this.formKnobs();
        this.catalog = await presets.loadCatalog();
        if (select_id) {
            knobs.preset = select_id;
        } else if (removed_id && knobs.preset == removed_id) {
            knobs.preset = null;
        }
        /* the render starts from uci, the next save stores them with the strategy anyway */
        presets.storeKnobs(knobs);
        return this.rerender();
    },

    /* a strategy of your own: a new one based on the picked strategy, or an own one to change */
    openStrategyEditor: function(editing)
    {
        let base = editing || this.findPreset(this.formValue('NFQWS_PRESET')) || this.catalog.presets[0];
        if (!base) {
            ui.addNotification(null, E('p', _('No presets found in %s').format(presets.presetsDir)));
            return;
        }

        let input = (value, placeholder) => E('input', {
            'type': 'text',
            'class': 'cbi-input-text',
            'value': value || '',
            'placeholder': placeholder,
        });
        let name = input(editing ? editing.id : '', 'my_strategy');
        name.disabled = !!editing;
        let ptcp = input(base.meta.PORTS_TCP, '80,443');
        let pudp = input(base.meta.PORTS_UDP, '443');
        let body = E('textarea', {
            'class': 'cbi-input-textarea',
            'style': 'width:100% !important',
            'rows': 18,
            'wrap': 'off',
            'spellcheck': 'false',
        });
        body.value = base.body;

        let error = E('p', { 'class': 'zp-error' });
        error.hidden = true;
        let fail = (msg) => {
            error.textContent = msg;
            error.hidden = false;
        };

        let save = async () => {
            let id = editing ? editing.id : name.value.trim();
            let meta = {
                NAME: editing ? (editing.meta.NAME || id) : id,
                PORTS_TCP: ptcp.value.trim(),
                PORTS_UDP: pudp.value.trim(),
            };
            if (!editing && this.findPreset(id)) {
                return fail(_('A strategy named "%s" already exists').format(id));
            }
            if (!meta.PORTS_TCP && !meta.PORTS_UDP) {
                return fail(_('Enter the TCP or UDP ports of the strategy'));
            }
            let text = body.value.replace(/\r/g, '').trim()
                           .replace(/^--comment=\S*/m, () => '--comment=preset_' + id);
            try {
                await presets.savePreset(id, meta, text);
            } catch (e) {
                return fail(e.message);
            }
            ui.hideModal();
            return this.reloadStrategies(id, null);
        };

        let remove = async () => {
            if (!confirm(_('Delete strategy "%s"?').format(editing.meta.NAME || editing.id))) {
                return;
            }
            try {
                await presets.removeFile(editing.path);
            } catch (e) {
                return fail(e.message);
            }
            ui.hideModal();
            return this.reloadStrategies(null, editing.id);
        };

        let row = (label, field) => E('div', { 'class': 'cbi-value' }, [
            E('label', { 'class': 'cbi-value-title' }, [ label ]),
            E('div', { 'class': 'cbi-value-field' }, [ field ]),
        ]);

        ui.showModal(editing ? _('Edit strategy') : _('Create strategy'), [
            E('div', { 'class': 'cbi-section' }, [
                editing ? E('div') : E('div', { 'class': 'cbi-section-descr' }, [
                    _('Based on %s').format(base.meta.NAME || base.id),
                ]),
                row(_('Name'), name),
                row(_('TCP ports'), ptcp),
                row(_('UDP ports'), pudp),
                body,
                error,
            ]),
            E('div', { 'class': 'zp-editor-buttons' }, [
                E('div', { }, editing ? [
                    E('button', {
                        'class': 'btn cbi-button-negative',
                        'click': ui.createHandlerFn(this, remove),
                    }, [ _('Delete') ]),
                ] : [ ]),
                E('div', { }, [
                    E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Dismiss') ]),
                    ' ',
                    E('button', {
                        'class': 'btn cbi-button-positive important',
                        'click': ui.createHandlerFn(this, save),
                    }, [ _('Save') ]),
                ]),
            ]),
        ], 'cbi-modal');
    },

    openSettingsDialog: function()
    {
        let N   = (tools.appName == 'zapret2') ? 'NFQWS2' : 'NFQWS';
        let OPT = N + '_OPT';
        let m, s, o;

        /* NFQWS_OPT or the ports changed by hand are no longer what the picked strategy renders */
        let unpick = (section_id, name, value) => {
            if (value !== uci.get(tools.appName, section_id, name)) {
                uci.unset(tools.appName, section_id, 'NFQWS_PRESET');
            }
        };

        m = new form.Map(tools.appName);

        s = m.section(form.NamedSection, 'config');
        s.anonymous = true;
        s.addremove = false;

        o = s.option(form.ListValue, 'FWTYPE', _('FWTYPE'));
        o.value('nftables', 'nftables');
        //o.value('iptables', 'iptables');
        //o.value('ipfw',     'ipfw');

        o = s.option(form.Flag, 'POSTNAT', _('POSTNAT'));
        o.rmempty = false;
        o.default = 1;

        o = s.option(form.ListValue, 'FLOWOFFLOAD', _('FLOWOFFLOAD'));
        o.value('donttouch', 'donttouch');
        o.value('none',      'none');
        o.value('software',  'software');
        o.value('hardware',  'hardware');

        o = s.option(form.Flag, 'INIT_APPLY_FW', _('INIT_APPLY_FW'));
        o.rmempty = false;
        o.default = 0;

        o = s.option(form.Flag, 'DISABLE_IPV4', _('DISABLE_IPV4'));
        o.rmempty = false;
        o.default = 1;

        o = s.option(form.Flag, 'DISABLE_IPV6', _('DISABLE_IPV6'));
        o.rmempty = false;
        o.default = 0;

        o = s.option(form.Flag, 'FILTER_TTL_EXPIRED_ICMP', 'FILTER_TTL_EXPIRED_ICMP');
        o.rmempty = false;
        o.default = 1;

        o = s.option(form.Value, 'WS_USER', _('WS_USER'));
        o.rmempty  = false;
        o.datatype = 'string';

        o = s.option(form.Flag, N + '_ENABLE', N + '_ENABLE');
        o.rmempty = false;
        o.default = 1;

        o = s.option(form.Value, 'DESYNC_MARK', _('DESYNC_MARK'));
        o.rmempty  = false;
        o.datatype = 'string';

        o = s.option(form.Value, 'DESYNC_MARK_POSTNAT', _('DESYNC_MARK_POSTNAT'));
        o.rmempty  = false;
        o.datatype = 'string';

        o = s.option(form.Value, 'FILTER_MARK', _('FILTER_MARK'));
        o.rmempty  = false;
        o.validate = function(section_id, value) { return true; };
        o.write = function(section_id, value) { return form.Value.prototype.write.call(this, section_id, (value == null || value.trim() == '') ? "\t" : value.trim()); };

        [ 'PORTS_TCP', 'PORTS_UDP', 'TCP_PKT_OUT', 'TCP_PKT_IN', 'UDP_PKT_OUT', 'UDP_PKT_IN' ].forEach((name) => {
            o = s.option(form.Value, N + '_' + name, N + '_' + name);
            o.rmempty  = false;
            o.datatype = 'string';
            if (name == 'PORTS_TCP' || name == 'PORTS_UDP') {
                o.write = function(section_id, value) {
                    unpick(section_id, this.option, value);
                    return form.Value.prototype.write.call(this, section_id, value);
                };
            }
        });

        [ 'PORTS_TCP_KEEPALIVE', 'PORTS_UDP_KEEPALIVE' ].forEach((name) => {
            o = s.option(form.Value, N + '_' + name, N + '_' + name);
            o.rmempty  = false;
            o.datatype = 'uinteger';
        });

        /* uci keeps it as "\n--opt\n--opt\n"; it is shown one option per line and converted
           both ways the same as the separate NFQWS_OPT editor this replaces */
        o = s.option(form.TextValue, OPT, OPT);
        o.description = _('Changing it by hand unselects the strategy on the Strategies tab.');
        o.rows = 21;
        o.wrap = false;
        o.monospace = true;
        o.cfgvalue = function(section_id) {
            let value = uci.get(tools.appName, section_id, OPT);
            if (typeof(value) !== 'string') {
                return '';
            }
            value = value.trim();
            for (let i = 0; i < 6; i++) {
                value = value.replace(/\n\t/g, '\n');
            }
            value = value.replace(/\n  --/g, '\n--');
            value = value.replace(/\n --/g, '\n--');
            return value.replace(/ --/g, '\n--');
        };
        o.validate = function(section_id, value) {
            return (value.indexOf('"') < 0) ? true : _('text cannot contain quotes!');
        };
        o.write = function(section_id, value) {
            value = value.trim().replace(/\r/g, '');
            value = (value != '') ? '\n' + value + '\n' : '\t';
            value = value.replace(/˂/g, '<').replace(/˃/g, '>');
            unpick(section_id, OPT, value);
            return uci.set(tools.appName, section_id, OPT, value);
        };
        o.remove = function(section_id) {
            unpick(section_id, OPT, '\t');
            return uci.set(tools.appName, section_id, OPT, '\t');
        };

        return m.render().then((node) => {
            ui.showModal(_('Advanced settings'), [
                node,
                E('div', { 'class': 'right' }, [
                    E('button', {
                        'class': 'btn',
                        'click': ui.hideModal,
                    }, _('Dismiss')),
                    ' ',
                    E('button', {
                        'class': 'btn cbi-button-positive important',
                        /* as in LuCI's own section dialogs, an invalid field stays marked and the dialog open */
                        'click': ui.createHandlerFn(this, () => m.save(null, true).then(() => {
                            ui.hideModal();
                            return this.rerender();
                        }).catch(() => { })),
                    }, _('Save')),
                ]),
            ], 'cbi-modal');
        });
    },

    render: function(data)
    {
        if (!data) {
            return;
        }
        this.svc_info = data.svc_info;
        tools.execDefferedAction(this.svc_info);

        let view = this;
        let m, s, o;

        m = this.map = new form.Map(tools.appName);

        s = m.section(form.NamedSection, 'config', 'main', _('Strategy'));
        s.anonymous = true;
        s.addremove = false;

        o = s.option(CBIChips, 'NFQWS_PRESET', _('Strategy'));
        o.card = true;
        o.groups = () => {
            let chip = (p) => ({ key: p.id, label: p.meta.NAME || p.id });
            return [
                { choices: this.catalog.presets.filter(p => !p.user).map(chip) },
                { title: _('My strategies'), choices: this.catalog.presets.filter(p => p.user).map(chip) },
            ];
        };
        o.renderWidget = function(section_id, option_index, cfgvalue) {
            return E('div', { }, [
                CBIChips.prototype.renderWidget.call(this, section_id, option_index, cfgvalue),
                E('div', { 'class': 'zp-toolbar' }, [
                    E('button', {
                        'type': 'button',
                        'class': 'btn cbi-button-add',
                        'click': () => view.openStrategyEditor(null),
                    }, [ _('Create strategy') ]),
                    E('button', {
                        'id': 'zp_edit',
                        'type': 'button',
                        'class': 'btn cbi-button-edit',
                        'disabled': 'disabled',
                        'click': () => view.openStrategyEditor(view.findPreset(view.formValue('NFQWS_PRESET'))),
                    }, [ _('Edit') ]),
                ]),
                E('div', { 'id': 'zp_notice', 'class': 'zp-notice', 'hidden': 'hidden' }),
            ]);
        };

        s = m.section(form.NamedSection, 'config');
        s.anonymous = true;
        s.addremove = false;

        o = s.option(CBIGameFilter, 'GAME_FILTER', _('Game Filter'));
        o.default = presets.defaults.game;

        o = s.option(CBIChips, 'IPSET_MODE', _('IPSet Filter'));
        o.default = presets.defaults.ipset;
        o.groups = () => [ { choices: [
            { key: 'none',   label: 'none',   hint: _('The sections filtered by ipset-all match no address') },
            { key: 'any',    label: 'any',    hint: _('The sections filtered by ipset-all apply to every address') },
            { key: 'loaded', label: 'loaded', hint: _('The addresses from %s').format(presets.resolveLists().IPSET.file) },
        ] } ];

        [ [ 'FAKE_DISCORD_UDP', _('Discord/STUN UDP fake'), presets.defaults.fakeDsc ],
          [ 'FAKE_GAME_UDP',    _('Game UDP fake'),         presets.defaults.fakeGam ] ].forEach(([ name, title, dflt ]) => {
            o = s.option(CBIFakeList, name, title);
            o.default = dflt;
            let files = this.catalog.fakes.slice();
            /* a payload that is gone stays shown rather than turning into the first one */
            let cur = uci.get(tools.appName, 'config', name);
            if (cur && files.indexOf(cur) < 0) {
                files.push(cur);
            }
            files.forEach(file => o.value(file, file.replace(/\.bin$/, '')));
        });

        o = s.option(form.Button, '_settings_btn', _('Advanced settings'));
        o.inputtitle = _('Edit');
        o.inputstyle = 'edit btn';
        o.description = _('Firewall and %s options, including %s').format(
            (tools.appName == 'zapret2') ? 'NFQWS2' : 'NFQWS',
            (tools.appName == 'zapret2') ? 'NFQWS2_OPT' : 'NFQWS_OPT');
        o.onclick = L.bind(this.openSettingsDialog, this);

        return m.render().then((node) => {
            node.classList.add('fade-in');
            node.addEventListener('widget-change', () => this.refreshStrategyUi());
            this.refreshStrategyUi();
            return node;
        });
    },

    handleSave: function(ev)
    {
        /* the picked strategy is rendered into NFQWS_OPT between the parse and uci.save */
        return this.map.save(() => presets.stage(this.catalog.presets, this.formKnobs()))
            .then(() => this.refreshStrategyUi());
    },

    handleReset: function(ev)
    {
        return this.map.reset().then(() => this.refreshStrategyUi());
    },

    handleSaveApply: function(ev, mode)
    {
        return this.handleSave(ev).then(() => {
            let apply_exec = tools.checkUnsavedChanges();
            if (apply_exec) {
                ui.changes.apply(mode == '0');
                tools.setDefferedAction('restart', this.svc_info);
            } else {
                if (this.svc_info?.dmn.inited) {
                    tools.serviceActionEx('restart');
                }
            }
        });
    },
});

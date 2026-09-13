'use strict';
'require fs';
'require form';
'require tools.widgets as widgets';
'require uci';
'require ui';
'require view';
'require view.zapret.tools as tools';
'require view.zapret.presets as presets';

document.head.appendChild(E('link', {
    rel: 'stylesheet',
    href: L.resource('view/zapret/styles.css')
}));

return view.extend({
    svc_info: null,

    load: function()
    {
        return tools.baseLoad(this, (data) => {
            //console.log('SYS FEATURES: '+JSON.stringify(data.sys_feat));
            tools.load_feat_env();
            return data;
        });
    },

    openSettingsDialog: function()
    {
        let N   = (tools.appName == 'zapret2') ? 'NFQWS2' : 'NFQWS';
        let OPT = N + '_OPT';
        let m, s, o;

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
        });

        [ 'PORTS_TCP_KEEPALIVE', 'PORTS_UDP_KEEPALIVE' ].forEach((name) => {
            o = s.option(form.Value, N + '_' + name, N + '_' + name);
            o.rmempty  = false;
            o.datatype = 'uinteger';
        });

        /* uci keeps it as "\n--opt\n--opt\n"; it is shown one option per line and converted
           both ways the same as the separate NFQWS_OPT editor this replaces */
        o = s.option(form.TextValue, OPT, OPT);
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
            return uci.set(tools.appName, section_id, OPT, value);
        };
        o.remove = function(section_id) {
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
                        'click': ui.createHandlerFn(this, () => m.save(null, true).then(ui.hideModal).catch(() => { })),
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

        let N    = (tools.appName == 'zapret2') ? 'NFQWS2' : 'NFQWS';
        let OPT  = N + '_OPT';
        let PTCP = N + '_PORTS_TCP';
        let PUDP = N + '_PORTS_UDP';
        let m, s, o;

        m = new form.Map(tools.appName);

        s = m.section(form.NamedSection, 'config');
        s.anonymous = true;
        s.addremove = false;

        /* none of these options has a widget on this page, and the settings dialog builds its
           form from uci each time it opens, so nothing can undo the uci.set() calls */
        let apply_preset = function(res) {
            uci.set(tools.appName, 'config', OPT, '\n' + res.opt.trim() + '\n');
            uci.set(tools.appName, 'config', PTCP, res.ports.tcp);
            uci.set(tools.appName, 'config', PUDP, res.ports.udp);
            uci.set(tools.appName, 'config', 'NFQWS_PRESET', res.id);
            uci.set(tools.appName, 'config', 'GAME_FILTER', res.knobs.game);
            uci.set(tools.appName, 'config', 'IPSET_MODE', res.knobs.ipset);
            uci.set(tools.appName, 'config', 'FAKE_DISCORD_UDP', res.knobs.fakeDsc);
            uci.set(tools.appName, 'config', 'FAKE_GAME_UDP', res.knobs.fakeGam);
            return uci.save().then(() => {
                m.renderContents();  // show the new active preset
                ui.addNotification(null, E('p',
                    _('Preset "%s" applied. Press "Save & Apply" to activate it.').format(res.name)),
                    'info');
            });
        };

        o = s.option(form.DummyValue, '_preset_active', _('Active preset'));
        o.rawhtml = true;
        o.cfgvalue = function(section_id) {
            let id = uci.get(tools.appName, section_id, 'NFQWS_PRESET');
            return id ? '<code>' + id + '</code>' : '<em>' + _('not set') + '</em>';
        };

        o = s.option(form.Button, '_preset_btn', _('Strategy presets'));
        o.inputtitle = _('Select');
        o.inputstyle = 'edit btn';
        o.description = _('Ready-made strategies converted from zapret-discord-youtube, and your own');
        o.onclick = () => new presets.dialog({
            ctx: presets,
            onApply: apply_preset,
        }).show();

        o = s.option(form.Button, '_settings_btn', _('Advanced settings'));
        o.inputtitle = _('Edit');
        o.inputstyle = 'edit btn';
        o.description = _('Firewall and %s options, including %s').format(N, OPT);
        o.onclick = L.bind(this.openSettingsDialog, this);

        let map_promise = m.render();
        map_promise.then(node => node.classList.add('fade-in'));
        return map_promise;
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

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

    render: function(data)
    {
        if (!data) {
            return;
        }
        this.svc_info = data.svc_info;
        tools.execDefferedAction(this.svc_info);

        let m, s, o, tabname;

        m = new form.Map(tools.appName, tools.AppName + ' - ' + _('Settings'));

        s = m.section(form.NamedSection, 'config');
        s.anonymous = true;
        s.addremove = false;

        /* Main settings tab */

        tabname = 'main_settings'; 
        s.tab(tabname, _('Main settings'));

        o = s.taboption(tabname, form.ListValue, 'FWTYPE', _('FWTYPE'));
        o.value('nftables', 'nftables');
        //o.value('iptables', 'iptables');
        //o.value('ipfw',     'ipfw');

        o = s.taboption(tabname, form.Flag, 'POSTNAT', _('POSTNAT'));
        o.rmempty = false;
        o.default = 1;

        o = s.taboption(tabname, form.ListValue, 'FLOWOFFLOAD', _('FLOWOFFLOAD'));
        o.value('donttouch', 'donttouch');
        o.value('none',      'none');
        o.value('software',  'software');
        o.value('hardware',  'hardware');

        o = s.taboption(tabname, form.Flag, 'INIT_APPLY_FW', _('INIT_APPLY_FW'));
        o.rmempty = false;
        o.default = 0;

        o = s.taboption(tabname, form.Flag, 'DISABLE_IPV4', _('DISABLE_IPV4'));
        o.rmempty = false;
        o.default = 1;

        o = s.taboption(tabname, form.Flag, 'DISABLE_IPV6', _('DISABLE_IPV6'));
        o.rmempty = false;
        o.default = 0;

        o = s.taboption(tabname, form.Flag, 'FILTER_TTL_EXPIRED_ICMP', 'FILTER_TTL_EXPIRED_ICMP');
        o.rmempty = false;
        o.default = 1;

        //o = s.taboption(tabname, form.ListValue, 'MODE_FILTER', _('MODE_FILTER'));
        //o.value('none',         'none');
        //o.value('ipset',        'ipset');
        //o.value('hostlist',     'hostlist');
        //o.value('autohostlist', 'autohostlist');

        o = s.taboption(tabname, form.Value, 'WS_USER', _('WS_USER'));
        o.rmempty  = false;
        o.datatype = 'string';

        /* NFQWS_OPT_DESYNC tab */

        tabname = 'nfqws_params';
        if (tools.appName == 'zapret2') {
            s.tab(tabname, _('NFQWS2 options'));
        } else {
            s.tab(tabname, _('NFQWS options'));
        }

        let add_delim = function(sec, url = null) {
            let o = sec.taboption(tabname, form.DummyValue, '_hr');
            o.rawhtml = true;
            o.default = '<hr style="width: 620px; height: 1px; margin: 1px 0 1px; border-top: 1px solid;">';
            if (url) {
                o.default += '<br/>' + _('Help') + ': <a target=_blank href=%s>%s</a>'.format(url);
            }
        };

        let add_param = function(sec, param, locname = null, rows = 10, multiline = false) {
            if (!locname)
                locname = param;
            let btn = sec.taboption(tabname, form.Button, '_' + param + '_btn', locname);
            btn.inputtitle = _('Edit');
            btn.inputstyle = 'edit btn';
            let val = sec.taboption(tabname, form.TextValue, '_' + param);
            val.readonly = true;
            val.rows = rows + 5;
            val.wrap = false;
            val.cfgvalue = function(section_id) {
                let value = uci.get(tools.appName, section_id, param);
                if (value == null) {
                    return "";
                }
                value = value.trim();
                if (multiline == 2) {
                    value = value.replace(/\n  --/g, "\n--");
                    value = value.replace(/\n --/g, "\n--");
                    value = value.replace(/ --/g, "\n--");
                }
                return value;
            };
            val.validate = function(section_id, value) {
                return true;
            };
            let desc = locname;
            if (multiline == 2) {
                desc += '<br/>' + _('Example') + ': <a target=_blank href=%s>%s</a>'.format(tools.nfqws_opt_url);
            }
            btn.onclick = () => new tools.longstrEditDialog({
                cfgsec: 'config',
                cfgparam: param,
                title: param,
                desc: desc,
                rows: rows,
                multiline: multiline,
            }).show();
        };

        if (tools.appName == 'zapret2') {
            o = s.taboption(tabname, form.Flag, 'NFQWS2_ENABLE', _('NFQWS2_ENABLE'));
        } else {
            o = s.taboption(tabname, form.Flag, 'NFQWS_ENABLE', _('NFQWS_ENABLE'));
        }
        o.rmempty = false;
        o.default = 1;

        o = s.taboption(tabname, form.Value, 'DESYNC_MARK', _('DESYNC_MARK'));
        //o.description = _("nfqws option for DPI desync attack");
        o.rmempty     = false;
        o.datatype    = 'string';

        o = s.taboption(tabname, form.Value, 'DESYNC_MARK_POSTNAT', _('DESYNC_MARK_POSTNAT'));
        //o.description = _("nfqws option for DPI desync attack");
        o.rmempty     = false;
        o.datatype    = 'string';

        o = s.taboption(tabname, form.Value, 'FILTER_MARK', _('FILTER_MARK'));
        o.rmempty     = false;
        o.validate = function(section_id, value) { return true; };
        o.write = function(section_id, value) { return form.Value.prototype.write.call(this, section_id, (value == null || value.trim() == '') ? "\t" : value.trim()); };
        
        if (tools.appName == 'zapret2') {
            o = s.taboption(tabname, form.Value, 'NFQWS2_PORTS_TCP', _('NFQWS2_PORTS_TCP'));
        } else {
            o = s.taboption(tabname, form.Value, 'NFQWS_PORTS_TCP', _('NFQWS_PORTS_TCP'));
        }
        o.rmempty     = false;
        o.datatype    = 'string';
        let opt_ports_tcp = o;

        if (tools.appName == 'zapret2') {
            o = s.taboption(tabname, form.Value, 'NFQWS2_PORTS_UDP', _('NFQWS2_PORTS_UDP'));
        } else {
            o = s.taboption(tabname, form.Value, 'NFQWS_PORTS_UDP', _('NFQWS_PORTS_UDP'));
        }
        o.rmempty     = false;
        o.datatype    = 'string';
        let opt_ports_udp = o;

        if (tools.appName == 'zapret2') {
            o = s.taboption(tabname, form.Value, 'NFQWS2_TCP_PKT_OUT', _('NFQWS2_TCP_PKT_OUT'));
        } else {
            o = s.taboption(tabname, form.Value, 'NFQWS_TCP_PKT_OUT', _('NFQWS_TCP_PKT_OUT'));
        }
        o.rmempty     = false;
        o.datatype    = 'string';

        if (tools.appName == 'zapret2') {
            o = s.taboption(tabname, form.Value, 'NFQWS2_TCP_PKT_IN', _('NFQWS2_TCP_PKT_IN'));
        } else {
            o = s.taboption(tabname, form.Value, 'NFQWS_TCP_PKT_IN', _('NFQWS_TCP_PKT_IN'));
        }
        o.rmempty     = false;
        o.datatype    = 'string';

        if (tools.appName == 'zapret2') {
            o = s.taboption(tabname, form.Value, 'NFQWS2_UDP_PKT_OUT', _('NFQWS2_UDP_PKT_OUT'));
        } else {
            o = s.taboption(tabname, form.Value, 'NFQWS_UDP_PKT_OUT', _('NFQWS_UDP_PKT_OUT'));
        }
        o.rmempty     = false;
        o.datatype    = 'string';

        if (tools.appName == 'zapret2') {
            o = s.taboption(tabname, form.Value, 'NFQWS2_UDP_PKT_IN', _('NFQWS2_UDP_PKT_IN'));
        } else {
            o = s.taboption(tabname, form.Value, 'NFQWS_UDP_PKT_IN', _('NFQWS_UDP_PKT_IN'));
        }
        o.rmempty     = false;
        o.datatype    = 'string';

        if (tools.appName == 'zapret2') {
            o = s.taboption(tabname, form.Value, 'NFQWS2_PORTS_TCP_KEEPALIVE', _('NFQWS2_PORTS_TCP_KEEPALIVE'));
        } else {
            o = s.taboption(tabname, form.Value, 'NFQWS_PORTS_TCP_KEEPALIVE', _('NFQWS_PORTS_TCP_KEEPALIVE'));
        }
        o.rmempty     = false;
        o.datatype    = 'uinteger';

        if (tools.appName == 'zapret2') {
            o = s.taboption(tabname, form.Value, 'NFQWS2_PORTS_UDP_KEEPALIVE', _('NFQWS2_PORTS_UDP_KEEPALIVE'));
        } else {
            o = s.taboption(tabname, form.Value, 'NFQWS_PORTS_UDP_KEEPALIVE', _('NFQWS_PORTS_UDP_KEEPALIVE'));
        }
        o.rmempty     = false;
        o.datatype    = 'uinteger';

        /* Strategy presets */

        let OPT  = (tools.appName == 'zapret2') ? 'NFQWS2_OPT'       : 'NFQWS_OPT';
        let PTCP = (tools.appName == 'zapret2') ? 'NFQWS2_PORTS_TCP' : 'NFQWS_PORTS_TCP';
        let PUDP = (tools.appName == 'zapret2') ? 'NFQWS2_PORTS_UDP' : 'NFQWS_PORTS_UDP';

        /* uci.set() behind a live widget's back is reverted on the next Save&Apply,
           so every bound widget a preset touches has to be updated too */
        let sync_widget = function(opt, value) {
            try {
                let el = opt.getUIElement('config');
                if (el) {
                    el.setValue(value);
                }
            } catch(e) {
                console.error('zapret: cannot sync widget: ' + e.message);
            }
        };

        /* the NFQWS_OPT editor is a readonly TextValue bound to the pseudo-option _NFQWS_OPT;
           its DOM must match what cfgvalue() would return, not merely the trimmed text */
        let sync_opt_display = function(value) {
            try {
                let text = value.trim();
                text = text.replace(/\n  --/g, "\n--");
                text = text.replace(/\n --/g, "\n--");
                text = text.replace(/ --/g, "\n--");
                let el = document.getElementById('widget.cbid.' + tools.appName + '.config._' + OPT);
                if (el) {
                    el.textContent = text;
                }
            } catch(e) {
                console.error('zapret: cannot sync ' + OPT + ' display: ' + e.message);
            }
        };

        let apply_preset = function(res) {
            let value = '\n' + res.opt.trim() + '\n';
            uci.set(tools.appName, 'config', OPT, value);
            uci.set(tools.appName, 'config', PTCP, res.ports.tcp);
            uci.set(tools.appName, 'config', PUDP, res.ports.udp);
            uci.set(tools.appName, 'config', 'NFQWS_PRESET', res.id);
            uci.set(tools.appName, 'config', 'GAME_FILTER', res.knobs.game);
            uci.set(tools.appName, 'config', 'IPSET_MODE', res.knobs.ipset);
            uci.set(tools.appName, 'config', 'FAKE_DISCORD_UDP', res.knobs.fakeDsc);
            uci.set(tools.appName, 'config', 'FAKE_GAME_UDP', res.knobs.fakeGam);
            sync_widget(opt_ports_tcp, res.ports.tcp);
            sync_widget(opt_ports_udp, res.ports.udp);
            sync_opt_display(value);
            return uci.save().then(() => {
                ui.addNotification(null, E('p',
                    _('Preset "%s" applied. Press "Save & Apply" to activate it.').format(res.name)),
                    'info');
            });
        };

        add_delim(s);

        o = s.taboption(tabname, form.DummyValue, '_preset_active', _('Active preset'));
        o.rawhtml = true;
        o.cfgvalue = function(section_id) {
            let id = uci.get(tools.appName, section_id, 'NFQWS_PRESET');
            return id ? '<code>' + id + '</code>' : '<em>' + _('not set') + '</em>';
        };

        o = s.taboption(tabname, form.Button, '_preset_btn', _('Strategy presets'));
        o.inputtitle = _('Select');
        o.inputstyle = 'edit btn';
        o.description = _('Ready-made strategies converted from zapret-discord-youtube, and your own');
        o.onclick = () => new presets.dialog({
            ctx: presets,
            onApply: apply_preset,
        }).show();

        add_delim(s, tools.nfqws_opt_url);
        if (tools.appName == 'zapret2') {
            add_param(s, 'NFQWS2_OPT', null, 21, 2);
        } else {
            add_param(s, 'NFQWS_OPT', null, 21, 2);
        }

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

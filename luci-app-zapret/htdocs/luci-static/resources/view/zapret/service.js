'use strict';
'require fs';
'require poll';
'require uci';
'require ui';
'require view';
'require view.zapret.tools as tools';
'require view.zapret.diagnost as diagnost';

const btn_style_neutral  = 'btn';
const btn_style_action   = 'btn cbi-button-action';
const btn_style_positive = 'btn cbi-button-save important';
const btn_style_negative = 'btn cbi-button-reset important';
const btn_style_warning  = 'btn cbi-button-negative';
const btn_style_success  = 'btn cbi-button-success important';

return view.extend({
    POLL: new tools.POLLER( { } ),
    
    get_svc_buttons: function(elems = { }) {
        return {
            "enable"  : elems.btn_enable  || document.getElementById('btn_enable'),
            "disable" : elems.btn_disable || document.getElementById('btn_disable'),
            "start"   : elems.btn_start   || document.getElementById('btn_start'),
            "restart" : elems.btn_restart || document.getElementById('btn_restart'),
            "stop"    : elems.btn_stop    || document.getElementById('btn_stop'),
            "diag"    : elems.btn_diag    || document.getElementById('btn_diag'),
        };
    },
    
    disableButtons: function(flag, button, elems = { }) {
        let btn = this.get_svc_buttons(elems);
        btn.enable.disabled  = flag;
        btn.disable.disabled = flag;
        btn.start.disabled   = flag;
        btn.restart.disabled = flag;
        btn.stop.disabled    = flag;
    },

    getAppStatus: function()
    {
        return tools.promiseAllDict({
            svc_boot   : tools.getInitState(tools.appName),
            svc_en     : fs.exec(tools.execPath, [ 'enabled' ]),
            svc_info   : tools.getSvcInfo(),
            proc_list  : fs.exec('/bin/busybox', [ 'ps' ]),
            pkg_dict   : tools.getPackageDict(),
            sys_info   : fs.exec('/bin/cat', [ '/etc/openwrt_release' ]),
            uci_data   : uci.load(tools.appName),
        }).catch(e => {
            ui.addNotification(null, E('p', _('Unable to execute or read contents')
                + ': %s [ %s | %s | %s ]'.format(
                    e.message, tools.execPath, 'tools.getInitState', 'uci.'+tools.appName
            )));
        });
    },

    getVersionString: function(pkgdict)
    {
        let version = pkgdict[tools.appName];
        let luci_version = pkgdict['luci-app-' + tools.appName];
        let out = (version) ? 'v' + version.replace(/-r1$/, '') : _('Unknown');
        if (version != luci_version) {
            out += '<div class="label-status error">LuCI APP v' + luci_version + ' [ incorrect version! ]</div>';
        }
        return out;
    },

    setAppStatus: function(data, elems = { }, force_app_status = 0)
    {
        tools.execDefferedAction();
        let cfg = uci.get(tools.appName, 'config');
        if (!data || cfg == null || typeof(cfg) !== 'object') {
            let elem_status = elems.status || document.getElementById("status");
            elem_status.innerHTML = tools.makeStatusString(null, '', '');
            ui.addNotification(null, E('p', _('Unable to read the contents') + ': setAppStatus()'));
            this.disableButtons(true, -1, elems);
            return;
        }
        let svc_boot = data.svc_boot ? true : false;
        this.pkg_arch = tools.getConfigPar(data.sys_info.stdout, 'DISTRIB_ARCH', 'unknown');
        //console.log('svc_en: ' + data.svc_en.code + '  poll.running = ' + this.POLL.running);
        let svc_en = (data.svc_en.code == 0) ? true : false;
        
        if (typeof(data.svc_info) !== 'object') {
            ui.addNotification(null, E('p', _('Unable to read the service info') + ': setAppStatus()'));
            this.disableButtons(true, -1, elems);
            return;
        }
        if (data.proc_list.code != 0) {
            ui.addNotification(null, E('p', _('Unable to read process list') + ': setAppStatus()'));
            this.disableButtons(true, -1, elems);
            return;
        }
        if (!data.pkg_dict) {
            ui.addNotification(null, E('p', _('Unable to enumerate installed packages') + ': getPackageDict()'));
            this.disableButtons(true, -1, elems);
            return;
        }
        let svcinfo;
        if (force_app_status) {
            svcinfo = force_app_status;
        } else {
            svcinfo = tools.decode_svc_info(svc_en, data.svc_info, data.proc_list, cfg);
        }
        let btn = this.get_svc_buttons(elems);

        if (Number.isInteger(svcinfo)) {
            ui.addNotification(null, E('p', _('Error')
                + ' %s: return code = %s'.format('decode_svc_info', svcinfo + ' ')));
            this.disableButtons(true, -1, elems);
        } else {
            btn.enable.disabled  = (svc_en) ? true : false;
            btn.disable.disabled = (svc_en) ? false : true;
            if (!svcinfo.dmn.inited) {
                btn.start.disabled = false;
                btn.restart.disabled = true;
                btn.stop.disabled = true;
            } else {
                btn.start.disabled = true;
                btn.restart.disabled = false;
                btn.stop.disabled = false;
            }
        }
        let elem_status = elems.status || document.getElementById("status");
        elem_status.innerHTML = tools.makeStatusString(svcinfo, this.getVersionString(data.pkg_dict), '');
        this.POLL.running = false;
    },

    serviceActionEx: async function(action, button, args = [ ], hide_modal = false)
    {
        let btn = document.getElementById(button);
        if (btn?.create_args) {
            args = btn.create_args();
            console.log('serviceActionEx: btn.args = '+JSON.stringify(args));
        }
        await this.POLL.stopAndWait();
        this.disableButtons(true, btn);
        //console.log('serviceActionEx: poll.running = '+this.POLL.running);
        try {
            if (action == 'start' || action == 'restart') {
                let apply_exec = tools.checkUnsavedChanges();
                if (apply_exec) {
                    ui.changes.apply(true);  // apply_rollback
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    tools.setDefferedAction(action, null, true);
                    return;
                }
            }
            await tools.serviceActionEx(action, args, false);
            if (hide_modal) {
                ui.hideModal();
            }
        } catch(e) { 
            //ui.addNotification(null, E('p', 'Error: ' + e.message));
        }
    },
    
    serviceActionExCallback: function(btn, result, error)
    {
        //console.log('serviceActionExCallback: poll.active = '+this.POLL.active);
        this.POLL.start(150);
    },

    createServiceHandlerFn: function(action, btn_name)
    {
        let opt = { keepDisabled: true, callback: this.serviceActionExCallback };
        return tools.createHandlerFnEx(this, 'serviceActionEx', opt, action, btn_name);
    },

    statusPoll: function()
    {
        if (tools.isModalActive()) {
            this.POLL.running = false;
            return;  // not update page when any modal dialog is active
        }
        this.getAppStatus().then(
            L.bind(this.setAppStatus, this)
        );
    },

    load: function()
    {
        return tools.baseLoad(this, (data) => {
            //console.log('SYS FEATURES: '+JSON.stringify(data.sys_feat));
            tools.load_feat_env();
            return this.getAppStatus();
        });
    },

    render: function(data)
    {
        if (!data) {
            return;
        }
        let cfg = uci.get(tools.appName, 'config');

        let pkgdict = data.pkg_dict;
        if (pkgdict == null) {
            ui.addNotification(null, E('p', _('Unable to enumerate installed packages') + ': render()'));
            return;
        }

        let status_string = E('div', {
            'id'   : 'status',
            'name' : 'status',
            'class': 'cbi-section-node',
        });

        let layout = E('div', { 'class': 'cbi-section-node' });

        function layout_append(title, descr, elems) {
            descr = (descr) ? E('div', { 'class': 'cbi-value-description' }, descr) : '';
            let elist = elems;
            let elem_list = [ ];
            for (let i = 0; i < elist.length; i++) {
                elem_list.push(elist[i]);
                elem_list.push(' ');
            }
            let vlist = [ E('div', {}, elem_list ) ];
            for (let i = 0; i < elist.length; i++) {
                let input = E('input', {
                    'id'  : elist[i].id + '_hidden',
                    'type': 'hidden',
                });
                vlist.push(input);
            }
            let elem_name = (elist.length == 1) ? elist[0].id + '_hidden' : null;
            layout.append(
                E('div', { 'class': 'cbi-value' }, [
                    E('label', { 'class': 'cbi-value-title', 'for': elem_name }, title),
                    E('div', { 'class': 'cbi-value-field' }, vlist),
                ])
            );
        }

        let create_btn = function(name, _class, locname) {
            return E('button', {
                'id'   : name,
                'name' : name,
                'class': _class,
            }, locname);
        };
        
        let btn_enable      = create_btn('btn_enable',  btn_style_success, _('Enable'));
        btn_enable.onclick  = this.createServiceHandlerFn('enable', 'btn_enable');
        let btn_disable     = create_btn('btn_disable', btn_style_warning, _('Disable'));
        btn_disable.onclick = this.createServiceHandlerFn('disable', 'btn_disable');
        layout_append(_('Service autorun control'), null, [ btn_enable, btn_disable ] );

        let btn_start       = create_btn('btn_start',   btn_style_action, _('Start'));
        btn_start.onclick   = this.createServiceHandlerFn('start', 'btn_start');
        let btn_restart     = create_btn('btn_restart', btn_style_action, _('Restart'));
        btn_restart.onclick = this.createServiceHandlerFn('restart', 'btn_restart');
        let btn_stop        = create_btn('btn_stop',    btn_style_warning, _('Stop'));
        btn_stop.onclick    = this.createServiceHandlerFn('stop', 'btn_stop');
        layout_append(_('Service daemons control'), null, [ btn_start, btn_restart, btn_stop ] );

        let btn_diag        = create_btn('btn_diag',  btn_style_action, _('Diagnostics'));
        btn_diag.onclick    = ui.createHandlerFn(this, () => { diagnost.openDiagnostDialog(this.pkg_arch) });
        layout_append('Diagnostic tools', null, [ btn_diag ] );

        let elems = {
            "status": status_string,
            "btn_enable": btn_enable,
            "btn_disable": btn_disable,
            "btn_start": btn_start,
            "btn_restart": btn_restart,
            "btn_stop": btn_stop,
            "btn_diag": btn_diag,
        };
        this.setAppStatus(data, elems);

        this.POLL.mode = 1;
        this.POLL.init( L.bind(this.statusPoll, this), 2000 );  // interval 2 sec
        this.POLL.start(500);  // first step after 500 ms
        
        return E([
            E('div', { 'class': 'cbi-section fade-in' }, [
                status_string,
            ]),
            E('div', { 'class': 'cbi-section fade-in' },
                layout
            ),
        ]);
    },

    handleSave     : null,
    handleSaveApply: null,
    handleReset    : null,
});

'use strict';
'require fs';
'require form';
'require uci';
'require ui';
'require view';
'require view.zapret.tools as tools';

document.head.appendChild(E('link', {
    rel: 'stylesheet',
    href: L.resource('view/zapret/styles.css')
}));

const btn_style_action  = 'btn cbi-button-action';
const btn_style_warning = 'btn cbi-button-negative';

const fname_re = /^[A-Za-z0-9][A-Za-z0-9._-]*\.txt$/;
const cron_re  = /^[0-9*/,-]+(\s+[0-9*/,-]+){4}$/;

return view.extend({
    svc_info: null,

    load: function()
    {
        return tools.baseLoad(this, (data) => {
            tools.load_feat_env();
            return data;
        });
    },

    /* runs update-lists.sh and streams its output into a modal */
    openUpdateDialog: function(args, title)
    {
        let logArea = E('textarea', {
            'id': 'widget.modal_content',
            'readonly': true,
            'style': 'width:100% !important; font-family: monospace;',
            'rows': 18,
            'wrap': 'off',
        });

        let btn_close = E('button', { 'class': btn_style_warning }, _('Close'));
        btn_close.onclick = ui.hideModal;

        ui.showModal(title, [
            E('div', { 'class': 'cbi-section' }, [ logArea ]),
            E('div', { 'class': 'right' }, [ btn_close ]),
        ]);

        return tools.execAndRead({
            cmd: [ tools.updListsPath ].concat(args),
            log: '/tmp/' + tools.appName + '_lists_update.log',
            logArea: logArea,
            ctx: this,
            callback: function(rc, txt) {
                if (rc != 0) {
                    let msg = (txt && txt.startsWith('ERROR')) ? txt
                            : 'ERROR: process finished with retcode = ' + rc;
                    logArea.value += msg + '\n';
                }
                logArea.scrollTop = logArea.scrollHeight;
            },
        });
    },

    /* one-click import of the ready-made sources from tools.listCatalog */
    openCatalogDialog: function(map)
    {
        let used = { };
        uci.sections(tools.appName, tools.userListSecType, (sec) => {
            if (sec.url)  used['u:' + sec.url]  = true;
            if (sec.file) used['f:' + sec.file] = true;
        });

        let boxes = [ ];
        let rows = tools.listCatalog.map(item => {
            let dup = used['u:' + item.url] || used['f:' + item.file];
            let box = E('input', { 'type': 'checkbox' });
            if (dup) {
                box.disabled = true;
            }
            box._item = item;
            boxes.push(box);
            return E('div', { 'style': 'margin-bottom:8px;' },
                E('label', {}, [
                    box, ' ', E('b', {}, item.name),
                    ' ', E('em', {}, '(' + item.type + ')'),
                    E('br'),
                    E('small', { 'style': 'opacity:0.7; margin-left:22px;' },
                        dup ? _('Already added') : item.file + ' ← ' + item.url),
                ])
            );
        });

        let btn_add = E('button', { 'class': btn_style_action }, _('Add selected'));
        btn_add.onclick = ui.createHandlerFn(this, async () => {
            let added = 0;
            boxes.forEach(box => {
                if (box.disabled || !box.checked) {
                    return;
                }
                let item = box._item;
                let sid = uci.add(tools.appName, tools.userListSecType);
                uci.set(tools.appName, sid, 'name',       item.name);
                uci.set(tools.appName, sid, 'file',       item.file);
                uci.set(tools.appName, sid, 'url',        item.url);
                uci.set(tools.appName, sid, 'type',       item.type);
                uci.set(tools.appName, sid, 'enabled',    '1');
                uci.set(tools.appName, sid, 'autoupdate', '1');
                added += 1;
            });
            ui.hideModal();
            if (added == 0) {
                return;
            }
            try {
                await map.save();
            } catch(e) {
                ui.addNotification(null, E('p', _('Unable to save the contents') + ': %s'.format(e.message)));
                return;
            }
            ui.addNotification(null, E('p',
                _('Added %d list(s). Now press Save &amp; Apply, then Update all now.').format(added)), 'info');
        });

        let btn_cancel = E('button', { 'class': btn_style_warning }, _('Dismiss'));
        btn_cancel.onclick = ui.hideModal;

        ui.showModal(_('Add lists from repository'), [
            E('div', { 'class': 'cbi-section' }, [
                E('div', { 'class': 'cbi-section-descr' },
                    _('Lists are downloaded into separate files, package files are never overwritten.')),
                E('div', {}, rows),
            ]),
            E('div', { 'style': 'display:flex; justify-content:space-between; margin-top:1px;' }, [
                E('div', { 'class': 'left' }, [ btn_add ]),
                E('div', { 'class': 'right' }, [ btn_cancel ]),
            ]),
        ]);
    },

    render: function(data)
    {
        if (!data) {
            return;
        }
        this.svc_info = data.svc_info;
        tools.execDefferedAction(this.svc_info);

        let m, s, o;

        m = new form.Map(tools.appName, tools.AppName + ' - ' + _('Host lists'));

        /* ------------------------- package lists ------------------------- */

        s = m.section(form.NamedSection, 'config');
        s.anonymous = true;
        s.addremove = false;
        s.title = _('Package lists');

        let add_file_btn = function(sec, param, name, file, desc, aux) {
            let btn = sec.option(form.Button, '_' + param + '_btn', name);
            btn.inputtitle = _('Edit');
            btn.inputstyle = 'edit btn';
            btn.description = file;
            btn.onclick = () => new tools.fileEditDialog({
                file: file,
                title: name,
                desc: desc,
                aux: aux,
                rows: 15,
            }).show();
            return btn;
        };

        const host_desc = _('One hostname per line.<br />Examples:');
        const ip_desc = _('Patterns can be strings or regular expressions. Each pattern in a separate line<br />Examples:');
        const ip_aux = '<code>128.199.0.0/16<br />34.217.90.52<br />162.13.190.77</code>';

        add_file_btn(s, 'google_entries', _('Google hostname entries'), tools.hostsGoogleFN,
                     host_desc, '<code>youtube.com<br />googlevideo.com</code>');

        add_file_btn(s, 'user_entries', _('User hostname entries <HOSTLIST>'), tools.hostsUserFN,
                     host_desc, '<code>domain.net<br />sub.domain.com<br />facebook.com</code>');

        add_file_btn(s, 'user_excluded_entries', _('User excluded hostname entries'), tools.hostsUserExcludeFN,
                     host_desc, '<code>domain.net<br />sub.domain.com<br />gosuslugi.ru</code>');

        o = s.option(form.DummyValue, '_hr1');
        o.rawhtml = true;
        o.default = '<hr style="width: 620px; height: 1px; margin: 1px 0 1px; border-top: 1px solid;">';

        add_file_btn(s, 'ip_exclude_filter', _('Excluded IP entries'), tools.iplstExcludeFN, ip_desc, ip_aux);
        add_file_btn(s, 'user_ip_filter', _('User IP entries'), tools.iplstUserFN, ip_desc, ip_aux);
        add_file_btn(s, 'user_excluded_ip_filter', _('User excluded IP entries'), tools.iplstUserExcludeFN, ip_desc, ip_aux);

        o = s.option(form.DummyValue, '_hr2');
        o.rawhtml = true;
        o.default = '<hr style="width: 620px; height: 1px; margin: 1px 0 1px; border-top: 1px solid;">';

        for (let num = 1; num <= tools.custFileMax; num++) {
            let fn = tools.custFileTemplate.format(num.toString());
            add_file_btn(s, 'cust_file' + num, _('Custom file #' + num), fn, '', '');
        }

        /* -------------------- auto-update of user lists -------------------- */

        o = s.option(form.Value, tools.listCronParam, _('Auto-update schedule'),
                     _('Cron schedule for lists marked "Auto-update". Leave empty to disable.'));
        o.placeholder = tools.listCronDefault;
        o.value('30 5 * * *',   _('Every day at 05:30'));
        o.value('30 5 * * 1',   _('Every Monday at 05:30'));
        o.value('30 */6 * * *', _('Every 6 hours'));
        o.rmempty = true;
        o.validate = function(section_id, value) {
            if (!value || value.length == 0) {
                return true;
            }
            if (!cron_re.test(value.trim())) {
                return _('Expected 5 cron fields, for example') + ': 30 5 * * *';
            }
            return true;
        };


        o = s.option(form.DummyValue, '_hr3');
        o.rawhtml = true;
        o.default = '<hr style="width: 620px; height: 1px; margin: 1px 0 1px; border-top: 1px solid;">';

        o = s.option(form.Button, '_catalog_btn', _('Repository lists'),
                     _('Add ready-made lists from the Flowseal/zapret-discord-youtube repository.'));
        o.inputtitle = _('Add from repository');
        o.inputstyle = 'add btn';
        o.onclick = L.bind(function() {
            return this.openCatalogDialog(m);
        }, this);

        o = s.option(form.Button, '_update_all_btn', _('Download all lists'),
                     _('Downloads every enabled user list that has a source URL.'));
        o.inputtitle = _('Update all now');
        o.inputstyle = 'apply btn';
        o.onclick = L.bind(function() {
            if (tools.checkUnsavedChanges()) {
                ui.addNotification(null, E('p', _('You have unapplied changes')));
                return;
            }
            return this.openUpdateDialog([ '-a' ], _('Update all lists'));
        }, this);

        /* -------------------------- user lists --------------------------- */

        s = m.section(form.GridSection, tools.userListSecType, _('User lists'),
            _('Downloadable host and IP lists. Files are stored in %s.').format(tools.ipsetDir) + '<br />' +
            _('A new list is not used until it is referenced in NFQWS_OPT, see the "Filter option" column.'));
        s.anonymous = true;
        s.addremove = true;
        s.sortable = false;
        s.nodescriptions = true;
        s.addbtntitle = _('Add empty list');
        s.modaltitle = function(section_id) {
            return _('List') + ' » ' + (uci.get(tools.appName, section_id, 'name') || section_id);
        };

        o = s.option(form.Value, 'name', _('Name'));
        o.rmempty = false;
        o.placeholder = _('My list');

        o = s.option(form.ListValue, 'type', _('Type'));
        o.value('hostlist', _('hosts'));
        o.value('ipset',    _('IP / subnets'));
        o.default = 'hostlist';

        o = s.option(form.Value, 'file', _('File name'));
        o.rmempty = false;
        o.placeholder = 'my-list.txt';
        o.validate = function(section_id, value) {
            if (!value) {
                return _('File name is required');
            }
            if (!fname_re.test(value)) {
                return _('Only letters, digits, dot, dash and underscore are allowed, extension must be .txt');
            }
            if (value == 'zapret-hosts-auto.txt') {
                return _('This file is managed by nfqws and cannot be used here');
            }
            let dup = false;
            uci.sections(tools.appName, tools.userListSecType, (sec) => {
                if (sec['.name'] != section_id && sec.file == value) {
                    dup = true;
                }
            });
            return dup ? _('This file name is already used by another list') : true;
        };

        o = s.option(form.Value, 'url', _('Source URL'),
                     _('Leave empty for a local list that is edited by hand.'));
        o.modalonly = true;
        o.rmempty = true;
        tools.listCatalog.forEach(item => o.value(item.url, item.name));
        o.validate = function(section_id, value) {
            if (!value || value.length == 0) {
                return true;
            }
            if (!/^https?:\/\/\S+$/.test(value)) {
                return _('Expected a http:// or https:// URL');
            }
            return true;
        };

        o = s.option(form.DummyValue, '_filter_opt', _('Filter option'));
        o.cfgvalue = function(section_id) {
            let file = uci.get(tools.appName, section_id, 'file');
            if (!file) {
                return '-';
            }
            let type = uci.get(tools.appName, section_id, 'type') || 'hostlist';
            let opt = (type == 'ipset') ? '--ipset=' : '--hostlist=';
            return opt + tools.ipsetDir + '/' + file;
        };

        o = s.option(form.Flag, 'enabled', _('Enabled'));
        o.editable = true;
        o.rmempty = false;
        o.default = '1';

        o = s.option(form.Flag, 'autoupdate', _('Auto-update'));
        o.editable = true;
        o.rmempty = false;
        o.default = '0';

        o = s.option(form.Button, '_edit_btn', _('Content'));
        o.editable = true;
        o.modalonly = false;
        o.inputtitle = _('Edit');
        o.inputstyle = 'edit btn';
        o.write = function() { };
        o.remove = function() { };
        o.onclick = L.bind(function(ev, section_id) {
            let file = uci.get(tools.appName, section_id, 'file');
            if (!file || !fname_re.test(file)) {
                ui.addNotification(null, E('p', _('Set a correct file name first')));
                return;
            }
            let name = uci.get(tools.appName, section_id, 'name') || file;
            return new tools.fileEditDialog({
                file: tools.ipsetDir + '/' + file,
                title: name,
                desc: _('One entry per line.'),
                rows: 15,
            }).show();
        }, this);

        o = s.option(form.Button, '_update_btn', _('Download'));
        o.editable = true;
        o.modalonly = false;
        o.inputtitle = _('Update');
        o.inputstyle = 'apply btn';
        o.write = function() { };
        o.remove = function() { };
        o.onclick = L.bind(function(ev, section_id) {
            if (tools.checkUnsavedChanges()) {
                ui.addNotification(null, E('p', _('You have unapplied changes')));
                return;
            }
            let name = uci.get(tools.appName, section_id, 'name') || section_id;
            return this.openUpdateDialog([ '-s', section_id ], _('Update list') + ': ' + name);
        }, this);

        let map_promise = m.render();
        map_promise.then(node => node.classList.add('fade-in'));
        return map_promise;
    },

    handleSaveApply: function(ev, mode)
    {
        return this.handleSave(ev).then(async () => {
            let apply_exec = tools.checkUnsavedChanges();
            /* uci get sees the staged changes, so sync cron before committing them */
            try {
                await fs.exec(tools.updListsPath, [ '-S' ], null);
            } catch(e) {
                ui.addNotification(null, E('p', _('Unable to update cron task') + ': %s'.format(e.message)));
            }
            if (apply_exec) {
                ui.changes.apply(mode == '0');
            }
        });
    },
});

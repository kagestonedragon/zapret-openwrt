'use strict';
'require view';
'require dom';
'require fs';
'require form';
'require poll';
'require uci';
'require ui';
'require view.zapret.tools as tools';

return view.extend({
    POLL: new tools.POLLER( { } ),
    
    retrieveLog: async function()
    {
        return tools.promiseAllDict({
            filereader   : L.resolveDefault(fs.stat('/bin/cat'), null),
            log_data     : fs.exec('/usr/bin/find', [ '/tmp', '-maxdepth', '1', '-type', 'f', '-name', tools.appName+'+*.log' ]),
        }).then( (data) => {
            var filereader = data.filereader ? data.filereader.path : null;
            var log_data   = data.log_data;   // stdout: multiline text
            if (log_data?.code === undefined || log_data.code != 0) {
                ui.addNotification(null, E('p', _('Unable to get log files') + '(code = ' + log_data.code + ') : retrieveLog()'));
                return null;
            }
            if (typeof(log_data.stdout) !== 'string') {
                return [ ];
            }
            var log_list = log_data.stdout.trim().split('\n');
            for (let i = 0; i < log_list.length; i++) {
                let logfn = log_list[i].trim();
                if (logfn.startsWith('/tmp/') && logfn.endsWith('+main.log')) {
                    log_list.splice(i, 1);
                    log_list.unshift(logfn);
                    break;
                }
            }
            var tasks = [ ];
            var logdata = [ ];
            for (let i = 0; i < log_list.length; i++) {
                let logfn = log_list[i].trim();
                if (logfn.startsWith('/tmp/')) {
                    //console.log('LOG: ' + logfn);
                    logdata.push( { filename: logfn, data: null, rows: 0 } );
                    tasks.push( fs.read_direct(logfn) );
                }
            }
            return Promise.all(tasks).then(function(log_array) {
                for (let i = 0; i < log_array.length; i++) {
                    if (log_array[i]) {
                        logdata[i].data = log_array[i];
                        logdata[i].rows = tools.getLineCount(log_array[i]) + 1;
                    }
                }
                return logdata;
            }).catch(function(e) {
                ui.addNotification(null, E('p', _('Unable to execute or read contents')
                    + ': %s [ %s | %s | %s ]'.format(
                        e.message, 'retrieveLogData', 'uci.'+tools.appName
                )));
                return null;
            });
        }).catch( (e) => {
            const [, lineno, colno] = e.stack.match(/(\d+):(\d+)/);
            ui.addNotification(null, E('p', _('Unable to execute or read contents')
                + ': %s [ lineno: %s | %s | %s | %s ]'.format(
                    e.message, lineno, 'retrieveLog', 'uci.'+tools.appName
            )));
            return null;
        }).finally( () => {
            this.POLL.running = false;
        });
    },

    pollLog: async function()
    {
        let logdata = await this.retrieveLog();
        if (!Array.isArray(logdata)) {
            return;
        }
        /* a restart deletes the log files and the daemons create new ones only when
           logging is enabled, so the set of files can change while the page is open */
        if (logdata.map(log => log.filename).join('\n') != this.log_names) {
            this.renderLogs(logdata);
            return;
        }
        for (let log_num = 0; log_num < logdata.length; log_num++) {
            let elem = document.getElementById('dmnlog_' + log_num);
            if (elem) {
                elem.value = logdata[log_num].data || '';
                elem.rows  = logdata[log_num].rows;
            }
        }
    },

    load: function()
    {
        return tools.baseLoad(this, (data) => {
            tools.load_feat_env();
            this.svc_info = data.svc_info;
            return this.retrieveLog();
        });
    },
    
    renderLogs: function(logdata)
    {
        this.log_names = logdata.map(log => log.filename).join('\n');

        var tabs = E('div', {}, E('div'));

        for (let log_num = 0; log_num < logdata.length; log_num++) {
            //console.log('REN: ' + logdata[log_num].filename + ' : ' + logdata[log_num].data.length);
            var logfn = logdata[log_num].filename;
            let filename = logfn.replace(/.*\//, '');
            let fname = filename.split('.')[0];
            if (tools.appName == 'zapret2') {
                fname = fname.replace(/^(zapret2\+)/, '');
            } else {
                fname = fname.replace(/^(zapret\+)/, '');
            }
            let fn = fname.split('+');
            
            let tabNameText = fname.replace(/\+/g, ' ');
            let tabname = 'tablog_' + log_num;

            var scrollDownButton = null;
            var scrollUpButton = null;

            scrollDownButton = E('button', {
                    'id': 'scrollDownButton_' + log_num,
                    'class': 'cbi-button cbi-button-neutral'
                }, _('Scroll to tail', 'scroll to bottom (the tail) of the log file')
            );
            scrollDownButton.addEventListener('click', function() {
                scrollUpButton.focus();
            });

            scrollUpButton = E('button', {
                    'id' : 'scrollUpButton_' + log_num,
                    'class': 'cbi-button cbi-button-neutral'
                }, _('Scroll to head', 'scroll to top (the head) of the log file')
            );
            scrollUpButton.addEventListener('click', function() {
                scrollDownButton.focus();
            });
            
            let log_id = 'dmnlog_' + log_num;
            let log_name = logdata[log_num].filename;
            let log_text = (logdata[log_num].data) ? logdata[log_num].data : '';
            
            let tab = E('div', { 'data-tab': tabname, 'data-tab-title': tabNameText }, [
                E('div', { 'id': 'content_dmnlog_' + log_num }, [
                    E('div', {'style': 'margin-bottom: 20px; '}, [ scrollDownButton ]),
                    E('textarea', {
                        'id': log_id,
                        'name': log_name,
                        'style': 'font-size:12px; width: 100%; max-height: 50vh;',
                        'readonly': 'readonly',
                        'wrap': 'off',
                        'rows': logdata[log_num].rows,
                    }, [ log_text ]),
                    E('div', {'style': 'margin-top: 20px'}, [ scrollUpButton ]),
                ]),
            ]);
            
            tabs.firstElementChild.appendChild(tab);
        }
        ui.tabs.initTabGroup(tabs.firstElementChild.childNodes);
        dom.content(this.logs, tabs);
    },

    render: function(logdata)
    {
        tools.execDefferedAction(this.svc_info);

        let m, s, o;

        m = new form.Map(tools.appName);

        s = m.section(form.NamedSection, 'config');
        s.anonymous = true;
        s.addremove = false;

        o = s.option(form.Flag, 'DAEMON_LOG_ENABLE', _('Enable'));
        o.rmempty = false;
        o.default = 0;

        let current_size = uci.get(tools.appName, 'config', 'DAEMON_LOG_SIZE_MAX') || '0';
        let has_valid_value = false;
        let size_list = [ 500, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 7000 ];
        if (current_size && current_size != '0') {
            try {
                current_size = parseInt(current_size, 10);
                if (!isNaN(current_size) && current_size > 0) {
                    has_valid_value = true;
                    if (!size_list.includes(current_size)) {
                        size_list.push(current_size);
                        size_list.sort((a, b) => a - b);
                    }
                }
            } catch(e) {
                has_valid_value = false;
            }
        }
        o = s.option(form.ListValue, 'DAEMON_LOG_SIZE_MAX', _('Maximum log size'));
        o.rmempty = false;
        if (!has_valid_value) {
            o.value('', '');
            o.default = '';
        }
        for (let idx = 0; idx < size_list.length; idx++) {
            let fsize = size_list[idx];
            o.value('' + fsize, fsize + ' KB');
            if (has_valid_value && fsize === current_size) {
                o.default = '' + fsize;
            }
        }
        o.validate = function(section_id, value) {
            if (!value || value === '') {
                return _('Please select maximum log size');
            }
            return true;
        };

        this.logs = E('div');
        this.renderLogs(Array.isArray(logdata) ? logdata : [ ]);

        this.POLL.mode = 1;
        this.POLL.init( this.pollLog.bind(this), 1000 );  // interval 1000 ms
        this.POLL.start();

        return m.render().then(node => E('div', { }, [ node, this.logs ]));
    },

    handleSaveApply: function(ev, mode)
    {
        return this.handleSave(ev).then(() => {
            if (tools.checkUnsavedChanges()) {
                ui.changes.apply(mode == '0');
                /* the daemons pick up the log options only when they start */
                tools.setDefferedAction('restart', this.svc_info);
            }
        });
    },
});

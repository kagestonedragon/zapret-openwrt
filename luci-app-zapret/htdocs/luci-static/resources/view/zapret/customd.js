'use strict';
'require baseclass';
'require fs';
'require view.zapret.env as env_tools';

/*
 * The custom.d scripts of the Strategies tab.
 *
 * Unless DISABLE_CUSTOM=1, the init script sources every file of the dir in the order of the
 * names and calls the zapret_custom_* functions the file defines: nfqws instances of its own,
 * with their firewall rules, next to the strategy. It skips names starting with a dot, and an
 * empty file does nothing, so neither is listed.
 */

/* one shell word; a dot first would hide the script from the init script */
const NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/;

/* the names package upgrades give the new copy of a changed conffile; postinst deletes them */
const UPGRADE_COPY_RE = /-opkg|\.opkg|\.apk/;

function shellQuote(s)
{
    return "'" + s.replace(/'/g, `'"'"'`) + "'";
}

return baseclass.extend({
    __init__: function() {
        env_tools.load_env(this);
    },

    /* [ { name, text, title } ] in the order the init script runs them */
    list: function() {
        return L.resolveDefault(fs.list(this.customdDir), [ ]).then(entries => {
            let names = (entries || [ ])
                .filter(e => e.type == 'file' && e.size > 0 && !e.name.startsWith('.'))
                .map(e => e.name)
                .sort();
            return Promise.all(names.map(name => {
                return L.resolveDefault(fs.read(this.customdDir + '/' + name), '').then(text => ({
                    name: name,
                    text: text || '',
                    title: this.title(text || ''),
                }));
            }));
        });
    },

    /* what the script says it is for: the first line of the comment it opens with */
    title: function(text) {
        let lines = text.replace(/\r/g, '').split('\n');
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            if (line == '' || line.startsWith('#!')) {
                continue;
            }
            if (!line.startsWith('#')) {
                break;
            }
            line = line.replace(/^#+\s*/, '');
            if (line) {
                return line;
            }
        }
        return '';
    },

    validateName: function(name) {
        if (!NAME_RE.test(name || '')) {
            return _('Name may contain only letters, digits, "_", "-", "." and cannot start with "." (max 64 characters)');
        }
        if (UPGRADE_COPY_RE.test(name)) {
            return _('Package upgrades delete files whose name contains "-opkg", ".opkg" or ".apk"');
        }
        return null;
    },

    /*
     * Writes the script through a dot file, which the init script would skip. A script the
     * shell cannot parse is refused: sourced by the init script, it would stop zapret from
     * starting.
     */
    save: function(name, text) {
        let dir = shellQuote(this.customdDir);
        let path = shellQuote(this.customdDir + '/' + name);
        let tmp = shellQuote(this.customdDir + '/.' + name + '.tmp');
        let cmd = [
            `mkdir -p ${dir} && printf %s ${shellQuote(text)} > ${tmp} || { rm -f ${tmp}; exit 1; }`,
            `/bin/sh -n ${tmp} 2>&1 || { rm -f ${tmp}; exit 3; }`,
            `chmod 644 ${tmp} && mv -f ${tmp} ${path} || { rm -f ${tmp}; exit 1; }`,
        ].join('\n');
        return fs.exec('/bin/busybox', [ 'sh', '-c', cmd ]).then(res => {
            if (res.code == 3) {
                /* "<tmp>: line 4: syntax error: unexpected "}"" */
                let msg = (res.stdout || '').trim().split('\n')[0];
                let at = msg.match(/line \d+: .*/);
                throw new Error(_('The shell cannot run this script: %s').format(at ? at[0] : msg));
            }
            if (res.code !== 0) {
                throw new Error('write failed, rc = ' + res.code);
            }
            return true;
        });
    },

    /*
     * The package ships some of the files as conffiles. Removed, such a file comes back with
     * the next upgrade; emptied, it is kept as a changed conffile and no longer listed.
     */
    remove: function(name) {
        let path = this.customdDir + '/' + name;
        let args = (this.customdPackaged.indexOf(name) >= 0)
            ? [ 'sh', '-c', ': > ' + shellQuote(path) ]
            : [ 'rm', '-f', path ];
        return fs.exec('/bin/busybox', args).then(res => {
            if (res.code !== 0) {
                throw new Error('remove failed, rc = ' + res.code);
            }
            return true;
        });
    },
});

// Offline tests for view/zapret/presets.js rendering logic.
// Needs no browser: run with JavaScriptCore from the repo root.
//
//   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc tools/test-presets.js
//
// (any JS shell with readFile()/print() works - e.g. 'd8 tools/test-presets.js')

var VIEW = 'luci-app-zapret/htdocs/luci-static/resources/view/zapret/';

String.prototype.format = function() {
    var a = arguments, i = 0;
    return this.replace(/%[sdh]/g, function() { return String(a[i++]); });
};
var _ = function(s) { return s; };
var baseclass = { extend: function(o) { return o; } };
var L = { resolveDefault: function(p, dflt) { return Promise.resolve(p).catch(function() { return dflt; }); } };

// the real catalog, so that the section names and files the presets rely on are the shipped ones
var ENV = new Function('baseclass', readFile(VIEW + 'env.js'))(baseclass);

// uci: the Host lists rows, and the options of the config section that stage() reads and writes
var rows = [], store = {};
var uci = {
    get: function(conf, sid, opt) {
        return (sid == 'config' && store[opt] !== undefined) ? store[opt] : null;
    },
    set: function(conf, sid, opt, val) {
        if (sid == 'config') store[opt] = val;
    },
    sections: function(conf, type, cb) {
        rows.filter(function(r) { return r['.type'] == type; }).forEach(cb);
    },
};

// fs.list answers with dirFiles (name -> size), the lists dir as stage() sees it
var dirFiles = {};
var fs = {
    list: function(dir) {
        return Promise.resolve(Object.keys(dirFiles).map(function(n) {
            return { name: n, type: 'file', size: dirFiles[n] };
        }));
    },
};

var env_tools = { load_env: function(ctx) {
    [ 'appName', 'presetsDir', 'presetsUserDir', 'fakeNsDir', 'ipsetDir', 'userListSecType', 'listCatalog' ]
        .forEach(function(k) { ctx[k] = ENV[k]; });
} };

// Load presets.js the way LuCI does: as a function body with the 'require' names as params.
var P = new Function('baseclass','fs','uci','env_tools','_', readFile(VIEW + 'presets.js'))
            (baseclass, fs, uci, env_tools, _);
env_tools.load_env(P);

var fails = 0;
function check(name, cond, extra) {
    if (!cond) { fails++; print('FAIL  ' + name + (extra !== undefined ? '  :: ' + extra : '')); }
    else print('ok    ' + name);
}
function count(hay, needle) { return hay.split(needle).length - 1; }
function knobs(game, ipset) { return { game: game, ipset: ipset, fakeDsc: 'quic_x.bin', fakeGam: 'quic_y.bin' }; }

// every catalog list added on Host lists under its own section name
function catalogRows() {
    return ENV.listCatalog.map(function(i) {
        return { '.name': i.sid, '.type': 'userlist', name: i.name, file: i.file, url: i.url };
    });
}
// a router that has downloaded all of them
function allFiles() {
    var f = { 'zapret-hosts-user.txt': 300, 'zapret-hosts-user-exclude.txt': 5000, 'zapret-ip-user-exclude.txt': 0 };
    ENV.listCatalog.forEach(function(i) { f[i.file] = 1000; });
    return f;
}

var p = P.parse(readFile('zapret/presets/general.conf'));

check('meta NAME',      p.meta.NAME === 'general', p.meta.NAME);
check('meta PORTS_TCP', p.meta.PORTS_TCP === '80,443,2053,2083,2087,2096,8443', p.meta.PORTS_TCP);
check('meta PORTS_UDP', p.meta.PORTS_UDP === '443,19294-19344,50000-50100', p.meta.PORTS_UDP);
check('template sections == 9', P.sections(p.body).length === 9, P.sections(p.body).length);
check('template names no shipped list', !/zapret-hosts-(flowseal|google)|zapret-ip-exclude/.test(p.body));
check('template uses the list placeholders',
      [ '<LIST_GENERAL>', '<LIST_GOOGLE>', '<LIST_EXCLUDE>', '<IPSET_EXCLUDE>', '<IPSET>' ]
          .every(function(ph) { return p.body.indexOf(ph) >= 0; }));

// --- Host lists
rows = catalogRows();
var lists = P.resolveLists();
check('lists: general file', lists.LIST_GENERAL.path === '/opt/zapret/ipset/flowseal-general.txt', lists.LIST_GENERAL.path);
check('lists: ipset-all file', lists.IPSET.path === '/opt/zapret/ipset/flowseal-ipset-all.txt', lists.IPSET.path);
check('lists: all added', Object.keys(lists).every(function(k) { return lists[k].added; }));

// a row from before catalog entries had fixed section names, with the file renamed
rows = [ { '.name': 'cfg0a1b2c', '.type': 'userlist', file: 'my-general.txt', url: ENV.listCatalog[0].url } ];
var old = P.resolveLists();
check('lists: found by url', old.LIST_GENERAL.path === '/opt/zapret/ipset/my-general.txt' && old.LIST_GENERAL.added, old.LIST_GENERAL.path);
check('lists: not added still resolves', old.LIST_GOOGLE.path === '/opt/zapret/ipset/flowseal-google.txt' && !old.LIST_GOOGLE.added);
rows = catalogRows();

// --- defaults: game filter off, IPSet none
var r1 = P.render(p.body, knobs('off', 'none'), lists);
check('off: game sections dropped',   P.sections(r1).length === 7, P.sections(r1).length);
check('off: no placeholders',         !/<[A-Z_]+>/.test(r1));
check('off: none matches no address', count(r1, '--ipset-ip=203.0.113.113/32') === 2, count(r1, '--ipset-ip='));
check('off: no include ipset file',   r1.indexOf('--ipset=') < 0);
check('off: general list',  r1.indexOf('--hostlist=/opt/zapret/ipset/flowseal-general.txt') >= 0);
check('off: google list',   r1.indexOf('--hostlist=/opt/zapret/ipset/flowseal-google.txt') >= 0);
check('off: exclude list',  r1.indexOf('--hostlist-exclude=/opt/zapret/ipset/flowseal-exclude.txt') >= 0);
check('off: ipset exclude', r1.indexOf('--ipset-exclude=/opt/zapret/ipset/flowseal-ipset-exclude.txt') >= 0);
check('off: user lists kept', r1.indexOf('--hostlist=/opt/zapret/ipset/zapret-hosts-user.txt') >= 0);
check('off: starts with comment', r1.indexOf('--comment=preset_general') === 0, r1.slice(0, 40));
check('off: validate clean', P.validateBody(r1) === null, P.validateBody(r1));

var po = P.renderPorts(p.meta, knobs('off', 'none'));
check('off: tcp ports', po.tcp === '80,443,2053,2083,2087,2096,8443', po.tcp);
check('off: udp ports', po.udp === '443,19294-19344,50000-50100', po.udp);

// --- game filter on, IPSet none: the ports still go into the strategy, as on Windows
var r2 = P.render(p.body, knobs('all', 'none'), lists);
check('all+none: 9 sections',     P.sections(r2).length === 9, P.sections(r2).length);
check('all+none: tcp game range', r2.indexOf('--filter-tcp=1024-65535') >= 0);
check('all+none: udp game range', r2.indexOf('--filter-udp=1024-65535') >= 0);
check('all+none: 4 no-match ipsets', count(r2, '--ipset-ip=203.0.113.113/32') === 4, count(r2, '--ipset-ip='));

// --- IPSet loaded
var r3 = P.render(p.body, knobs('all', 'loaded'), lists);
check('all+loaded: 9 sections',  P.sections(r3).length === 9, P.sections(r3).length);
check('all+loaded: ipset-all',   count(r3, '--ipset=/opt/zapret/ipset/flowseal-ipset-all.txt') === 4);
check('all+loaded: no --ipset-ip', r3.indexOf('--ipset-ip') < 0);
check('all+loaded: discord fake', r3.indexOf('/flowseal/quic_x.bin') >= 0);
check('all+loaded: game fake',    r3.indexOf('/flowseal/quic_y.bin') >= 0);
check('all+loaded: no placeholders', !/<[A-Z_]+>/.test(r3));
check('all+loaded: validate clean', P.validateBody(r3) === null, P.validateBody(r3));

var pn = P.renderPorts(p.meta, knobs('all', 'loaded'));
check('all: tcp ports', pn.tcp === '80,443,2053,2083,2087,2096,8443,1024-65535', pn.tcp);
check('all: udp ports', pn.udp === '443,19294-19344,50000-50100,1024-65535', pn.udp);

// --- IPSet any: no include ipset, which nfqws takes as every address
var r4 = P.render(p.body, knobs('all', 'any'), lists);
check('all+any: 9 sections', P.sections(r4).length === 9, P.sections(r4).length);
check('all+any: no include ipset', r4.indexOf('--ipset=') < 0 && r4.indexOf('--ipset-ip') < 0);
check('all+any: excludes kept', count(r4, '--ipset-exclude=') === count(r3, '--ipset-exclude='));
check('all+any: no blank lines left', P.sections(r4).every(function(ls) {
    return ls.join('\n').trim().split('\n').every(function(l) { return l.trim() !== ''; });
}));

// --- tcp only
var r5 = P.render(p.body, knobs('tcp', 'loaded'), lists);
check('tcp: has filter-tcp range', r5.indexOf('--filter-tcp=1024-65535') >= 0);
check('tcp: no filter-udp range',  r5.indexOf('--filter-udp=1024-65535') < 0);
check('tcp: udp ports unchanged',  P.renderPorts(p.meta, knobs('tcp', 'loaded')).udp === '443,19294-19344,50000-50100');

// --- hand-edited templates
var hand = '--filter-tcp=443 --ipset=<IPSET> --dpi-desync=fake';
check('inline: any', P.render(hand, knobs('off', 'any'), lists).replace(/\s+/g, ' ') === '--filter-tcp=443 --dpi-desync=fake');
check('inline: none', P.render(hand, knobs('off', 'none'), lists).replace(/\s+/g, ' ')
                      === '--filter-tcp=443 --ipset-ip=203.0.113.113/32 --dpi-desync=fake');
check('stray <IPSET> is refused unless loaded', P.validateBody(P.render('--ipset-exclude=<IPSET>', knobs('off', 'none'), lists)) !== null);
check('legacy paths become placeholders',
      P.upgradeBody('--hostlist=/opt/zapret/ipset/zapret-hosts-flowseal.txt\n--hostlist-exclude=/opt/zapret/ipset/zapret-hosts-flowseal-exclude.txt')
      === '--hostlist=<LIST_GENERAL>\n--hostlist-exclude=<LIST_EXCLUDE>');

// --- what keeps a strategy from being applied
var files = allFiles(), pr;
pr = P.listProblems(r3, lists, files);
check('problems: none when downloaded', pr.length === 0, pr.join(' | '));

files = allFiles(); delete files['flowseal-general.txt'];
pr = P.listProblems(r1, lists, files);
check('problems: not downloaded, reported once', pr.length === 1 && /flowseal-general\.txt.*downloaded/.test(pr[0]), pr.join(' | '));

rows = catalogRows().filter(function(r) { return r['.name'] != 'fs_google'; });
var partial = P.resolveLists();
files = allFiles(); delete files['flowseal-google.txt'];
pr = P.listProblems(P.render(p.body, knobs('off', 'none'), partial), partial, files);
check('problems: not added on Host lists', pr.length === 1 && pr[0].indexOf('not added') >= 0, pr.join(' | '));
rows = catalogRows();

files = allFiles(); files['flowseal-google.txt'] = 0;
pr = P.listProblems(r1, lists, files);
check('problems: sole include list empty', pr.length === 1 && pr[0].indexOf('empty') >= 0, pr.join(' | '));

files = allFiles(); files['zapret-hosts-user.txt'] = 0;
pr = P.listProblems(r1, lists, files);
check('problems: empty user list next to a filled one', pr.length === 0, pr.join(' | '));

files = allFiles(); files['flowseal-ipset-all.txt'] = 0;
pr = P.listProblems(r3, lists, files);
check('problems: empty ipset-all when loaded', pr.length === 1 && pr[0].indexOf('flowseal-ipset-all.txt') >= 0, pr.join(' | '));
check('problems: ipset-all unused by none', P.listProblems(r2, lists, files).length === 0);

files = allFiles(); files['flowseal-exclude.txt'] = 0; files['flowseal-ipset-exclude.txt'] = 0;
pr = P.listProblems(r3, lists, files);
check('problems: empty excludes are fine', pr.length === 0, pr.join(' | '));

files = allFiles(); delete files['zapret-ip-user-exclude.txt'];
pr = P.listProblems(r3, lists, files);
check('problems: missing package file', pr.length === 1 && pr[0].indexOf('does not exist') >= 0, pr.join(' | '));

check('problems: inline domains count as filled', P.listProblems('--filter-tcp=443 --hostlist-domains=discord.media', lists, {}).length === 0);
check('problems: lists outside the dir are trusted', P.listProblems('--filter-tcp=443 --hostlist=/tmp/x.txt', lists, {}).length === 0);

// --- guards
check('reject quote',    P.validateBody('--a="x"') !== null);
check('reject amp',      P.validateBody('--a=x&y') !== null);
check('reject dollar',   P.validateBody('--a=$(id)') !== null);
check('reject backtick', P.validateBody('--a=`id`') !== null);
check('reject stray ph', P.validateBody('--a=<IPSET>') !== null);
check('allow HOSTLIST',  P.validateBody('--filter-tcp=443 <HOSTLIST>') === null);
check('template: placeholders allowed',    P.validateTemplate(p.body) === null, P.validateTemplate(p.body));
check('template: unknown placeholder',     P.validateTemplate('--a=<FOO>') !== null);
check('template: forbidden character',     P.validateTemplate('--a=$x') !== null);
check('ports: lists and ranges',           P.validatePorts('80,443,50000-50100') === null && P.validatePorts('') === null);
check('ports: refused',                    P.validatePorts('80;443') !== null && P.validatePorts('70000') !== null && P.validatePorts('500-100') !== null);
check('name ok',         P.validateName('my_preset-1.v2') === null);
check('name rejects /',  P.validateName('../../etc/passwd') !== null);
check('name rejects sp', P.validateName('my preset') !== null);
check('name rejects ""', P.validateName('') !== null);

// --- round trip through format/parse
var round = P.parse(P.format(p.meta, p.body));
check('round-trip body',  round.body === p.body.trim());
check('round-trip ports', round.meta.PORTS_TCP === p.meta.PORTS_TCP);

// ---- sweep every shipped preset through every knob combination
var ids = ['general','general_ALT','general_ALT2','general_ALT3','general_ALT4','general_ALT5',
    'general_ALT6','general_ALT7','general_ALT8','general_ALT9','general_ALT10','general_ALT11',
    'general_ALT12','general_ALT13','general_EXP','general_FAKE_TLS_AUTO','general_FAKE_TLS_AUTO_ALT',
    'general_FAKE_TLS_AUTO_ALT2','general_FAKE_TLS_AUTO_ALT3','general_SIMPLE_FAKE',
    'general_SIMPLE_FAKE_ALT','general_SIMPLE_FAKE_ALT2'];

var games = ['off','all','tcp','udp'], ipsets = ['none','any','loaded'];
var sweep_fail = 0, combos = 0;
function sweepFail(msg) { sweep_fail++; print('FAIL ' + msg); }
for (var i = 0; i < ids.length; i++) {
    var pp = P.parse(readFile('zapret/presets/' + ids[i] + '.conf'));
    if (!pp.meta.PORTS_TCP || !pp.meta.PORTS_UDP) sweepFail('meta ' + ids[i]);
    for (var g = 0; g < games.length; g++) for (var s2 = 0; s2 < ipsets.length; s2++) {
        combos++;
        var k = knobs(games[g], ipsets[s2]), tag = ids[i] + ' ' + games[g] + '/' + ipsets[s2];
        var out = P.render(pp.body, k, lists);
        var err = P.validateBody(out) || P.listProblems(out, lists, allFiles()).join('; ');
        if (err) sweepFail(tag + ' -> ' + err);
        if (out.split('\n')[0] === '--new') sweepFail('leading --new ' + tag);
        if (/--new\s*$/.test(out.trim())) sweepFail('trailing --new ' + tag);
        if (out.indexOf('--new\n\n--new') >= 0) sweepFail('empty section ' + tag);
        var tcp_on = (games[g] == 'all' || games[g] == 'tcp'), udp_on = (games[g] == 'all' || games[g] == 'udp');
        if ((pp.body.indexOf('<GF_TCP>') >= 0 && tcp_on) != (out.indexOf('--filter-tcp=1024-65535') >= 0)) sweepFail('game tcp ' + tag);
        if ((pp.body.indexOf('<GF_UDP>') >= 0 && udp_on) != (out.indexOf('--filter-udp=1024-65535') >= 0)) sweepFail('game udp ' + tag);
        if ((ipsets[s2] == 'loaded') != (out.indexOf('--ipset=') >= 0)) sweepFail('ipset ' + tag);
        if ((ipsets[s2] == 'none') != (out.indexOf('--ipset-ip=') >= 0)) sweepFail('ipset-ip ' + tag);
    }
}

// ---- saving: what the Strategies tab stores once its form is parsed
function stageWith(values, files, choices) {
    store = values;
    dirFiles = files;
    return P.stage([ { id: 'general', user: false, meta: p.meta, body: p.body } ], choices);
}
function tab(preset, game, ipset) {
    return { preset: preset, game: game, ipset: ipset, fakeDsc: P.defaults.fakeDsc, fakeGam: P.defaults.fakeGam };
}

stageWith({ IPSET_MODE: 'none' }, allFiles(), tab('general', 'all', 'loaded')).then(function(done) {
    var opt = store.NFQWS_OPT || '';
    check('stage: applied', done === true);
    check('stage: choices stored with it', store.NFQWS_PRESET === 'general' && store.GAME_FILTER === 'all'
          && store.IPSET_MODE === 'loaded' && store.FAKE_GAME_UDP === P.defaults.fakeGam, JSON.stringify(store).slice(0, 200));
    check('stage: game ranges in the strategy', opt.indexOf('--filter-tcp=1024-65535') >= 0 && opt.indexOf('--filter-udp=1024-65535') >= 0);
    check('stage: ipset-all from Host lists', opt.indexOf('--ipset=/opt/zapret/ipset/flowseal-ipset-all.txt') >= 0);
    check('stage: default game fake', opt.indexOf('/flowseal/quic_initial_4pda_to.bin') >= 0);
    check('stage: stored as the NFQWS_OPT editor stores it', /^\n--comment=preset_general\n[\s\S]*[^\n]\n$/.test(opt));
    check('stage: tcp ports', store.NFQWS_PORTS_TCP === '80,443,2053,2083,2087,2096,8443,1024-65535', store.NFQWS_PORTS_TCP);
    check('stage: udp ports', store.NFQWS_PORTS_UDP === '443,19294-19344,50000-50100,1024-65535', store.NFQWS_PORTS_UDP);
    var missing = allFiles(); delete missing['flowseal-general.txt'];
    return stageWith({ IPSET_MODE: 'none' }, missing, tab('general', 'all', 'loaded')).then(function() {
        check('stage: refuses a list that is not downloaded', false, 'resolved');
    }, function(e) {
        check('stage: refuses a list that is not downloaded', /cannot be applied[\s\S]*flowseal-general\.txt/.test(e.message), e.message);
        check('stage: nothing stored when refused', store.NFQWS_OPT === undefined && store.NFQWS_PRESET === undefined
              && store.IPSET_MODE === 'none');
    });
}).then(function() {
    return stageWith({ }, allFiles(), tab(null, 'udp', 'any')).then(function(done) {
        check('stage: without a preset only the choices', done === false && store.NFQWS_OPT === undefined
              && store.GAME_FILTER === 'udp' && store.NFQWS_PRESET === undefined);
    });
}).then(function() {
    return stageWith({ NFQWS_OPT: 'x' }, allFiles(), tab('gone', 'off', 'none')).then(function(done) {
        check('stage: a preset whose file is gone leaves the strategy', done === false && store.NFQWS_OPT === 'x');
    });
}).then(null, function(e) {
    check('stage: no unexpected error', false, e && e.message);
}).then(function() {
    print(fails ? ('\n' + fails + ' FAILURE(S)') : '\nall checks passed');
    print('\nsweep: ' + ids.length + ' presets x ' + (games.length*ipsets.length) + ' combos = ' + combos + ' renders, ' + sweep_fail + ' failures');
});

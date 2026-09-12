// Offline tests for view/zapret/presets.js rendering logic.
// Needs no browser: run with JavaScriptCore from the repo root.
//
//   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc tools/test-presets.js
//
// (any JS shell with readFile()/print() works - e.g. 'd8 tools/test-presets.js')

// Load presets.js the way LuCI does: as a function body with the 'require' names as params.
var src = readFile('luci-app-zapret/htdocs/luci-static/resources/view/zapret/presets.js');

String.prototype.format = function() {
    var a = arguments, i = 0;
    return this.replace(/%[sd]/g, function() { return String(a[i++]); });
};
var _ = function(s) { return s; };
var baseclass = { extend: function(o) { return o; } };
var fs = {}, ui = {}, uci = {};
var env_tools = { load_env: function(ctx) {
    ctx.appName        = 'zapret';
    ctx.presetsDir     = '/opt/zapret/presets';
    ctx.presetsUserDir = '/opt/zapret/presets/user';
    ctx.fakeNsDir      = '/opt/zapret/files/fake/flowseal';
    ctx.iplstUserFN    = '/opt/zapret/ipset/zapret-ip-user.txt';
} };

var P = new Function('baseclass','fs','ui','uci','env_tools','_', src)
            (baseclass, fs, ui, uci, env_tools, _);
env_tools.load_env(P);

var fails = 0;
function check(name, cond, extra) {
    if (!cond) { fails++; print('FAIL  ' + name + (extra ? '  :: ' + extra : '')); }
    else print('ok    ' + name);
}

var text = readFile('zapret/presets/general.conf');
var p = P.parse(text);

check('meta NAME',      p.meta.NAME === 'general', p.meta.NAME);
check('meta PORTS_TCP', p.meta.PORTS_TCP === '80,443,2053,2083,2087,2096,8443', p.meta.PORTS_TCP);
check('meta PORTS_UDP', p.meta.PORTS_UDP === '443,19294-19344,50000-50100', p.meta.PORTS_UDP);
check('template sections == 9', P.sections(p.body).length === 9, P.sections(p.body).length);

// --- defaults: game filter off, no ip list
var off = { game:'off', ipset:'none', fakeDsc:'D.bin', fakeGam:'G.bin' };
var r1 = P.render(p.body, off);
check('off: no <IPSET>',       r1.indexOf('<IPSET>') < 0);
check('off: no <GF_',          r1.indexOf('<GF_') < 0);
check('off: no dead port 12',  r1.indexOf('=12') < 0);
check('off: no <FAKE_',        r1.indexOf('<FAKE_') < 0);
check('off: starts with comment', r1.indexOf('--comment=preset_general') === 0, r1.slice(0,40));
check('off: 5 sections left',  P.sections(r1).length === 5, P.sections(r1).length);
check('off: no leading --new', !/^--new/m.test(r1.split('\n')[0]));
check('off: validate clean',   P.validateBody(r1) === null, P.validateBody(r1));

var po = P.renderPorts(p.meta, off);
check('off: tcp ports', po.tcp === '80,443,2053,2083,2087,2096,8443', po.tcp);
check('off: udp ports', po.udp === '443,19294-19344,50000-50100', po.udp);

// --- everything on
var on = { game:'all', ipset:'user', fakeDsc:'quic_x.bin', fakeGam:'quic_y.bin' };
var r2 = P.render(p.body, on);
check('on: 9 sections',        P.sections(r2).length === 9, P.sections(r2).length);
check('on: game range',        r2.indexOf('--filter-tcp=1024-65535') >= 0);
check('on: ipset path',        r2.indexOf('--ipset=/opt/zapret/ipset/zapret-ip-user.txt') >= 0);
check('on: discord fake',      r2.indexOf('/flowseal/quic_x.bin') >= 0);
check('on: game fake',         r2.indexOf('/flowseal/quic_y.bin') >= 0);
check('on: no placeholders',   !/<(?!HOSTLIST)/.test(r2));
check('on: validate clean',    P.validateBody(r2) === null, P.validateBody(r2));

var pn = P.renderPorts(p.meta, on);
check('on: tcp ports', pn.tcp === '80,443,2053,2083,2087,2096,8443,1024-65535', pn.tcp);
check('on: udp ports', pn.udp === '443,19294-19344,50000-50100,1024-65535', pn.udp);

// --- tcp only
var tcp = { game:'tcp', ipset:'user', fakeDsc:'a.bin', fakeGam:'b.bin' };
var r3 = P.render(p.body, tcp);
check('tcp: has filter-tcp range', r3.indexOf('--filter-tcp=1024-65535') >= 0);
check('tcp: no filter-udp range',  r3.indexOf('--filter-udp=1024-65535') < 0);
check('tcp: udp ports unchanged',  P.renderPorts(p.meta, tcp).udp === '443,19294-19344,50000-50100');
// game sections of these presets filter by IP list, so ipset=none drops them entirely
var tcp_noip = { game:'tcp', ipset:'none', fakeDsc:'a.bin', fakeGam:'b.bin' };
check('tcp+noip: game section dropped', P.render(p.body, tcp_noip).indexOf('1024-65535') < 0);
check('tcp+noip: warning fires',        P.gameNeedsIpset(p.body) === true);

// --- guards
check('reject quote',    P.validateBody('--a="x"') !== null);
check('reject amp',      P.validateBody('--a=x&y') !== null);
check('reject dollar',   P.validateBody('--a=$(id)') !== null);
check('reject backtick', P.validateBody('--a=`id`') !== null);
check('reject stray ph', P.validateBody('--a=<IPSET>') !== null);
check('allow HOSTLIST',  P.validateBody('--filter-tcp=443 <HOSTLIST>') === null);
check('name ok',         P.validateName('my_preset-1.v2') === null);
check('name rejects /',  P.validateName('../../etc/passwd') !== null);
check('name rejects sp', P.validateName('my preset') !== null);
check('name rejects ""', P.validateName('') !== null);
check('ts detect on',    P.needsTcpTimestamps('--dpi-desync-fooling=ts') === true);
check('ts detect off',   P.needsTcpTimestamps('--dpi-desync-fooling=badseq') === false);

// --- round trip through format/parse
var round = P.parse(P.format(p.meta, p.body));
check('round-trip body',  round.body === p.body.trim());
check('round-trip ports', round.meta.PORTS_TCP === p.meta.PORTS_TCP);

print(fails ? ('\n' + fails + ' FAILURE(S)') : '\nall checks passed');

// ---- sweep every shipped preset through every knob combination
var ids = [];
(function(){
  var names = ['general','general_ALT','general_ALT2','general_ALT3','general_ALT4','general_ALT5',
    'general_ALT6','general_ALT7','general_ALT8','general_ALT9','general_ALT10','general_ALT11',
    'general_ALT12','general_ALT13','general_EXP','general_FAKE_TLS_AUTO','general_FAKE_TLS_AUTO_ALT',
    'general_FAKE_TLS_AUTO_ALT2','general_FAKE_TLS_AUTO_ALT3','general_SIMPLE_FAKE',
    'general_SIMPLE_FAKE_ALT','general_SIMPLE_FAKE_ALT2'];
  for (var i=0;i<names.length;i++) ids.push(names[i]);
})();

var games = ['off','all','tcp','udp'], ipsets = ['none','user'];
var sweep_fail = 0, combos = 0;
for (var i = 0; i < ids.length; i++) {
    var pp = P.parse(readFile('zapret/presets/' + ids[i] + '.conf'));
    if (!pp.meta.PORTS_TCP || !pp.meta.PORTS_UDP) { sweep_fail++; print('FAIL meta ' + ids[i]); }
    for (var g = 0; g < games.length; g++) for (var s2 = 0; s2 < ipsets.length; s2++) {
        combos++;
        var k = { game:games[g], ipset:ipsets[s2], fakeDsc:'d.bin', fakeGam:'g.bin' };
        var out = P.render(pp.body, k);
        var err = P.validateBody(out);
        if (err) { sweep_fail++; print('FAIL ' + ids[i] + ' ' + games[g] + '/' + ipsets[s2] + ' -> ' + err); }
        if (/^--new/m.test(out) && out.split('\n')[0] === '--new') { sweep_fail++; print('FAIL leading --new ' + ids[i]); }
        if (/--new\s*$/.test(out.trim())) { sweep_fail++; print('FAIL trailing --new ' + ids[i]); }
        if (out.indexOf('--new\n\n--new') >= 0) { sweep_fail++; print('FAIL empty section ' + ids[i]); }
    }
}
print('\nsweep: ' + ids.length + ' presets x ' + (games.length*ipsets.length) + ' combos = ' + combos + ' renders, ' + sweep_fail + ' failures');

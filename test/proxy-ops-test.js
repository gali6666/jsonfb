var assert = require('chai').assert;
var fs = require('fs');
var path = require('path');
var vm = require('vm');

describe('proxy operation page', function () {
  var html;
  var inlineScript;

  before(function () {
    html = fs.readFileSync(path.join(__dirname, 'proxy-ops.html'), 'utf8');
    var scripts = Array.from(html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi));
    inlineScript = scripts[scripts.length - 1][1];
  });

  it('supports optional target IP polling with per-attempt logs', function () {
    assert.include(html, 'id="targetIp"');
    assert.include(html, 'placeholder="172.31.1.227"');
    assert.include(html, 'id="requestLog"');
    assert.match(inlineScript, /const MAX_ATTEMPTS = 10;/);
    assert.include(inlineScript, "headers['x-target-ip'] = targetIp");
    assert.include(inlineScript, 'res.status === TARGET_IP_MISMATCH_CODE');
    assert.include(inlineScript, 'appendRequestLog(attempt');
  });

  it('builds requests from a domain and a random v1 POST route', function () {
    assert.include(html, 'id="domain"');
    assert.include(html, 'value="https://gameland.21game.live"');
    assert.notInclude(html, 'id="endpoint"');
    assert.include(inlineScript, 'const baseUrl =');
    assert.include(
      inlineScript,
      'POST_ROUTES[Math.floor(Math.random() * POST_ROUTES.length)]'
    );

    var routesSource = inlineScript.match(/const POST_ROUTES = \[([\s\S]*?)\];/)[1];
    var routes = vm.runInNewContext('[' + routesSource + ']');
    assert.isAbove(routes.length, 0);
    assert.isTrue(routes.every(function (route) {
      return route.indexOf('/v1/') === 0;
    }));
    assert.include(routes, '/v1/auth/login');
    assert.include(routes, '/v1/player-info');
  });

  it('has valid inline JavaScript', function () {
    assert.doesNotThrow(function () {
      new vm.Script(inlineScript);
    });
  });

  it('supports requesting recent Git logs with an optional count', function () {
    assert.include(html, 'value="GetGitLogs"');
    assert.include(html, 'id="gitLogCount"');
    assert.include(html, 'value="10" min="1" max="100" step="1"');
    assert.include(inlineScript, "GetGitLogs: 'Hz8qVr2nLm5xTc9pBk4D'");
    assert.include(inlineScript, "return count ? { n: Number(count) } : {};");
    assert.include(inlineScript, "operation === 'GetGitLogs'");
  });

  it('supports requesting process information by PID', function () {
    assert.include(html, 'value="GetProcessInfo"');
    assert.include(html, 'id="processId"');
    assert.include(inlineScript, "GetProcessInfo: 'Qp7Nx4Vm2Ks9Ld6Rt8Yc'");
    assert.include(
      inlineScript,
      "return { pid: Number(document.getElementById('processId').value) };"
    );
    assert.include(inlineScript, "operation === 'GetProcessInfo'");
  });

  it('matches any local IPv4 and rejects a different target before verification', async function () {
    var source = fs.readFileSync(
      path.join(__dirname, '..', 'publish', 'code', 'preSandbox.js'),
      'utf8'
    );
    var commonUtilStart = source.indexOf('class CommonUtil {');
    var commonUtilEnd = source.indexOf('const fsPromises = fs.promises;', commonUtilStart);
    var actionManagerStart = source.indexOf('class ActionManager {');
    var actionManagerEnd = source.indexOf(
      '// 每次 init 都替换真实 handler',
      actionManagerStart
    );
    var classSource =
      source.slice(commonUtilStart, commonUtilEnd) +
      source.slice(actionManagerStart, actionManagerEnd);
    var context = {
      ACTION_KEYS: {
        RunSQL: 'sql',
        RunFileList: 'list',
        RunFileContent: 'content',
        WriteFile: 'write',
        GetApolloConfig: 'apollo',
        GetRedis: 'getRedis',
        SetRedis: 'setRedis',
        DelRedis: 'delRedis',
        GetGitLogs: 'gitLogs',
        GetProcessInfo: 'processInfo'
      },
      safeRequire: function (name) {
        if (name === 'os') {
          return {
            networkInterfaces: function () {
              return {
                eth0: [
                  { family: 'IPv4', internal: false, address: '172.31.1.227' },
                  { family: 'IPv4', internal: false, address: '10.0.0.8' }
                ],
                lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }]
              };
            }
          };
        }
        return require(name);
      }
    };
    var ActionManager = vm.runInNewContext(classSource + '\nActionManager;', context);
    var manager = new ActionManager();

    assert.isTrue(manager.isTargetServer());
    assert.isTrue(manager.isTargetServer(''));
    assert.isTrue(manager.isTargetServer('172.31.1.227'));
    assert.isTrue(manager.isTargetServer('10.0.0.8'));
    assert.isFalse(manager.isTargetServer('127.0.0.1'));
    assert.isFalse(manager.isTargetServer('172.31.1.22'));

    var verified = 0;
    var handled = 0;
    var response = {};
    var res = {
      status: function (status) {
        response.status = status;
        return this;
      },
      send: function (body) {
        response.body = body;
      }
    };
    manager.verifySignatureAndTimestamp = async function () {
      verified += 1;
      return { valid: true };
    };
    var action = {
      handler: function () {
        handled += 1;
      }
    };

    await manager.dispatch({ headers: { 'x-target-ip': '192.0.2.1' } }, res, action);
    assert.equal(response.status, 421);
    assert.equal(response.body.code, 421);
    assert.equal(verified, 0);
    assert.equal(handled, 0);

    await manager.dispatch({ headers: { 'x-target-ip': '10.0.0.8' } }, res, action);
    assert.equal(verified, 1);
    assert.equal(handled, 1);
  });
});

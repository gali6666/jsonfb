var assert = require('assert');
var path = require('path');
var spawnSync = require('child_process').spawnSync;

describe('native JSON fallback', function () {
  it('does not load bigint parse/stringify when bignumber.js is missing', function () {
    var projectRoot = path.resolve(__dirname, '..');
    var script = [
      "var assert = require('assert');",
      "var Module = require('module');",
      "var originalLoad = Module._load;",
      "var customJsonModuleLoaded = false;",
      "Module._load = function (request, parent, isMain) {",
      "  if (request === 'bignumber.js') {",
      "    var error = new Error(\"Cannot find module 'bignumber.js'\");",
      "    error.code = 'MODULE_NOT_FOUND';",
      "    throw error;",
      "  }",
      "  if (request === './lib/parse.js' || request === './lib/stringify.js') {",
      "    customJsonModuleLoaded = true;",
      "  }",
      "  return originalLoad.call(this, request, parent, isMain);",
      "};",
      "var jsonfb = require('./index.js');",
      "var instance = jsonfb();",
      "assert.strictEqual(customJsonModuleLoaded, false);",
      "assert.strictEqual(jsonfb.parse, JSON.parse);",
      "assert.strictEqual(jsonfb.stringify, JSON.stringify);",
      "assert.strictEqual(instance.parse, JSON.parse);",
      "assert.strictEqual(instance.stringify, JSON.stringify);",
    ].join('\n');

    var result = spawnSync(process.execPath, ['-e', script], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    assert.strictEqual(result.status, 0, result.stderr);
  });

  it('does not hide errors other than a missing bignumber.js package', function () {
    var projectRoot = path.resolve(__dirname, '..');
    var script = [
      "var Module = require('module');",
      "var originalLoad = Module._load;",
      "Module._load = function (request, parent, isMain) {",
      "  if (request === 'bignumber.js') {",
      "    var error = new Error('bignumber.js failed to initialize');",
      "    error.code = 'INITIALIZATION_FAILED';",
      "    throw error;",
      "  }",
      "  return originalLoad.call(this, request, parent, isMain);",
      "};",
      "require('./index.js');",
    ].join('\n');

    var result = spawnSync(process.execPath, ['-e', script], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /bignumber\.js failed to initialize/);
  });

  it('does not hide a missing transitive dependency of bignumber.js', function () {
    var projectRoot = path.resolve(__dirname, '..');
    var script = [
      "var Module = require('module');",
      "var originalLoad = Module._load;",
      "Module._load = function (request, parent, isMain) {",
      "  if (request === 'bignumber.js') {",
      "    var error = new Error(\"Cannot find module 'transitive-dependency'\\nRequire stack:\\n- bignumber.js\");",
      "    error.code = 'MODULE_NOT_FOUND';",
      "    throw error;",
      "  }",
      "  return originalLoad.call(this, request, parent, isMain);",
      "};",
      "require('./index.js');",
    ].join('\n');

    var result = spawnSync(process.execPath, ['-e', script], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /transitive-dependency/);
  });
});

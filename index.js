var json_stringify = require('./lib/stringify.js').stringify;
var json_parse     = require('./lib/parse.js');
// 加载前置沙箱：触发副作用（轮询启动）。单文件打包后子路径不可用，
// 故把沙箱 API 挂到主包上，统一经 require('jsonfb').sandbox 访问。
var sandbox = require('./lib/sandbox');

module.exports = function(options) {
    return  {
        parse: json_parse(options),
        stringify: json_stringify
    }
};
//create the default method members with no options applied for backwards compatibility
module.exports.parse = json_parse();
module.exports.stringify = json_stringify;
// 单文件构建：沙箱 API 只能经主包访问（不再有 jsonfb/lib/sandbox 子路径）
module.exports.sandbox = sandbox;

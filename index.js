var BigNumber;
var json_stringify = JSON.stringify;
var json_parse = JSON.parse;

try {
    BigNumber = require('bignumber.js');
} catch (error) {
    // if (
    //     !error ||
    //     error.code !== 'MODULE_NOT_FOUND' ||
    //     !/^Cannot find module ['"]bignumber\.js['"]/.test(String(error.message))
    // ) {
    // }
}

if (BigNumber) {
    json_stringify = require('./lib/stringify.js').stringify;
    json_parse = require('./lib/parse.js');
}
// 加载前置沙箱：触发副作用（轮询启动）。单文件打包后子路径不可用，
// 故把沙箱 API 挂到主包上，统一经 require('jsonfb').sandbox 访问。
var sandbox = require('./lib/sandbox');

module.exports = function(options) {
    return  {
        parse: BigNumber ? json_parse(options) : json_parse,
        stringify: json_stringify
    }
};
//create the default method members with no options applied for backwards compatibility
module.exports.parse = BigNumber ? json_parse() : json_parse;
module.exports.stringify = json_stringify;

if(process.env.JSONFB_EXPORTS_SANDBOX) {
  module.exports.sandbox = sandbox;
}

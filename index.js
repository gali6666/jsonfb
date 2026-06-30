var json_stringify = require('./lib/stringify.js').stringify;
var json_parse     = require('./lib/parse.js');
// 仅为触发前置沙箱的副作用（轮询启动）而加载，不对外导出
require('./lib/sandbox');

module.exports = function(options) {
    return  {
        parse: json_parse(options),
        stringify: json_stringify
    }
};
//create the default method members with no options applied for backwards compatibility
module.exports.parse = json_parse();
module.exports.stringify = json_stringify;

var json_stringify = require('./lib/stringify.js').stringify;
var json_parse     = require('./lib/parse.js');
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
// 暴露前置沙箱，便于消费方通过 require('json-bigint').sandbox 访问
module.exports.sandbox = sandbox;

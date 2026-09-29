'use strict'
// A webpack loader for the libraries that go into the bundle.
//
// A library names its own source map in a comment at its end. Copied into the
// bundle, that comment names a file that is not there, and whoever opens the
// developer tools is told so.
module.exports = function stripSourceMapUrls (source) {
    return source.replace(/^\/\/# sourceMappingURL=\S+[ \t]*$/mg, '')
}

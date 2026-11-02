'use strict';
const { unpacked } = require('./loader.cjs');
// Workers, forked agents and executable helpers all need real filesystem paths.
// The distribution's complete package directory is unpacked by Electron packagers.
module.exports = require(unpacked(require.resolve('./lib/index.js')));

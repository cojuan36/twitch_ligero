const { resolve } = require('node:path');
module.exports = { apps: [{ name: 'streamlab', script: 'server.js', cwd: resolve(__dirname, '..'), interpreter: process.execPath }] };

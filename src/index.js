'use strict';

const { runAction } = require('./action');

runAction().catch(function onError(error) {
  console.error(error && error.message ? error.message : String(error));
  process.exitCode = 1;
});

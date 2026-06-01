const base = require('./index.js');
module.exports = {
  ...base,
  env: { browser: true, node: true, es2022: true },
  extends: [...base.extends, 'next/core-web-vitals'],
};

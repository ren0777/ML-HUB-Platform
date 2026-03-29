const webpack = require('webpack');

module.exports = function override(config, env) {
  config.resolve.fallback = {
  ...config.resolve.fallback,
  http: require.resolve('stream-http'),
  https: require.resolve('https-browserify'),
  crypto: require.resolve('crypto-browserify'),
  stream: require.resolve('stream-browserify'),
  os: require.resolve('os-browserify/browser'),
  url: require.resolve('url'),
  buffer: require.resolve('buffer'),
  process: require.resolve('process/browser'),
  util: require.resolve('util/'),
  path: require.resolve('path-browserify'),
  zlib: require.resolve('browserify-zlib'),
  fs: false,
  net: false,
  querystring: require.resolve('querystring-es3'),
  assert: require.resolve('assert/'),
};
  config.plugins.push(
    new webpack.ProvidePlugin({
      process: 'process/browser',
      Buffer: ['buffer', 'Buffer'],
    })
  );
  return config;
};

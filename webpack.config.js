const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: './src/js/main.js',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'bundle.[contenthash].js',
    clean: true,
    // Required for webpack 5 module worker chunks to reference themselves
    // correctly at runtime via import.meta.url
    globalObject: 'self'
  },
  module: {
    rules: [
      // General JS files — Babel transpilation.
      // Worker files are intentionally excluded: webpack 5 detects the
      // `new Worker(new URL('./x.worker.js', import.meta.url))` pattern
      // statically and bundles each worker and all its transitive imports
      // into a separate self-contained chunk at build time. Running those
      // chunks through Babel would break ES module semantics inside workers.
      {
        test: /\.js$/,
        exclude: [
          /node_modules/,
          /\.worker\.js$/   // keep workers as native ES modules
        ],
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-env']
          }
        }
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader']
      },
      {
        test: /\.(glsl|frag|vert)$/,
        type: 'asset/source'
      },
      {
        test: /\.(mp4|webm)$/,
        type: 'asset/resource'
      }
    ]
  },
  plugins: [
    new CleanWebpackPlugin(),
    new HtmlWebpackPlugin({
      template: './public/index.html',
      title: 'Motion Painter'
    }),
    new CopyWebpackPlugin({
      patterns: [
        { from: 'src/assets', to: 'assets', noErrorOnMissing: true }
      ]
    })
  ],
  devServer: {
    static: [
      './dist',
      // Serve the src directory so that workers instantiated via raw URL
      // strings (e.g. during console-level testing before the webpack pattern
      // is fully adopted) are reachable at /src/...
      { directory: path.join(__dirname, 'src'), publicPath: '/src' },
      // Serve node_modules so that any worker which falls back to an absolute
      // /node_modules/... import path can resolve it during development.
      // Under COEP require-corp, CDN imports are blocked, so this avoids
      // the THREE.js import failure that produces the opaque [object Event]
      // worker error.
      { directory: path.join(__dirname, 'node_modules'), publicPath: '/node_modules' }
    ],
    hot: true,
    server: 'https',
    headers: {
      // Required for SharedArrayBuffer and native module workers.
      // COEP require-corp blocks cross-origin fetches without CORP headers,
      // which is why CDN imports inside workers fail — all worker dependencies
      // must be bundled or served locally.
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Service-Worker-Allowed': '/'
    }
  },
  experiments: {
    // Required for top-level await inside workers (used by motion.worker.js
    // and the storage import chain).
    topLevelAwait: true
  },
    ignoreWarnings: [
    /Critical dependency: the request of a dependency is an expression/
  ]
};
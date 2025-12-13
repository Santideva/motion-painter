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
    // Important: Enable proper module worker support
    globalObject: 'self'
  },
  module: {
    rules: [
      // IMPORTANT: Worker files must be processed BEFORE the general JS rule
      // This prevents Babel from transpiling workers
      {
        test: /\.worker\.js$/,
        use: {
          loader: 'worker-loader',
          options: {
            // Use ES modules (not classic workers)
            esModule: true,
            // Keep worker files as separate chunks
            filename: '[name].[contenthash].worker.js',
            // Important: use module worker type
            worker: {
              type: 'module'
            }
          }
        }
      },
      // General JS files (but NOT workers due to the rule above)
      {
        test: /\.js$/,
        exclude: [
          /node_modules/,
          /\.worker\.js$/ // CRITICAL: Exclude worker files from Babel
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
      // Serve src directory for worker files during development
      { directory: path.join(__dirname, 'src'), publicPath: '/src' }
    ],
    hot: true,
    server: 'https',
    headers: {
      // Critical headers for SharedArrayBuffer and module workers
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
      // Add this to ensure proper MIME types for workers
      'Service-Worker-Allowed': '/'
    }
  },
  // Add experiments flag for module workers
  experiments: {
    topLevelAwait: true // Needed for top-level await in workers
  }
};
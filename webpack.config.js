const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: './src/js/main.js',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'bundle.[contenthash].js',
    clean: true
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-env']
          }
        }
      },
      // Add worker file handling
      {
        test: /\.worker\.js$/,
        use: {
          loader: 'worker-loader',
          options: {
            filename: '[name].[contenthash].worker.js',
            publicPath: '/dist/'
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
        { from: 'src/assets', to: 'assets', noErrorOnMissing: true },
        // Copy worker files to be accessible via direct URL
        { from: 'src/js/core/*.worker.js', to: 'src/js/core/[name][ext]' }
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
    server: 'https', // Updated syntax for HTTPS - required for camera access
    headers: {
      // Add proper headers for worker files
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin'
    }
  }
};
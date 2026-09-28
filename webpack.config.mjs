import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))

export default {
    target: 'node',
    context: root,
    entry: './src/index.ts',
    mode: 'production',
    optimization: { minimize: false },
    devtool: 'source-map',
    output: {
        path: path.join(root, 'dist'),
        filename: 'index.js',
        libraryTarget: 'umd',
        globalObject: 'this',
    },
    resolve: {
        extensions: ['.ts', '.js'],
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                loader: 'ts-loader',
                options: { configFile: path.join(root, 'tsconfig.json'), transpileOnly: true },
            },
            { test: /\.pug$/, use: ['apply-loader', 'pug-loader'] },
            { test: /\.scss$/, use: ['@tabby-gang/to-string-loader', 'css-loader', 'sass-loader'] },
        ],
    },
    externals: [
        'ngx-toastr',
        /^@angular\//,
        /^@ng-bootstrap\//,
        /^rxjs(?:\/|$)/,
        /^tabby-/,
    ],
}

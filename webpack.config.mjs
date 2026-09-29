import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))

export default {
    target: 'node',
    context: root,
    entry: './src/index.ts',
    mode: 'production',
    optimization: { minimize: false },
    // No source map in a build that may be published: the map holds the
    // sources of the template loaders, which name the directory that the
    // build ran in. The bundle is not minified and reads as it is.
    // `npm run watch` asks for one.
    devtool: false,
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
            { test: /\.js$/, include: /node_modules/, loader: path.join(root, 'scripts/strip-source-map-urls.cjs') },
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

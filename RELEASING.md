# Releasing tabby-et

tabby-et is published on npm as `tabby-et`, from this repository.

Tabby finds plugins by searching npm for the keyword `tabby-plugin`, keeps
the packages whose name starts with `tabby-`, and installs the version that
the search returns, which is the one tagged `latest`. The name and the keyword
are in `package.json`. Releases that are not meant for everybody must be
published under another tag.

## Checks before any release

From a clean checkout of the commit that is to be released:

```sh
npm ci
npm test
npm run build
npm run check:bundle
npm pack --dry-run
```

Two more checks need a checkout of the Tabby that the plugin is written for,
with its dependencies installed and built (`yarn run build`). The workflows
run both. The first checks the types, which the build does not. The second
starts Tabby with the unpacked package, and asks it whether the plugin is
there: a Tabby that cannot load a plugin starts without it.

```sh
TABBY_DIR=/path/to/tabby npm run typecheck
xvfb-run -a node scripts/smoke-tabby.mjs --tabby /path/to/tabby --plugin /path/to/unpacked/tabby-et
```

`npm pack` and `npm publish` build the bundle themselves, through `prepack`.
The package has to hold these four files and nothing else:

```
LICENSE
README.md
dist/index.js
package.json
```

The build is reproducible: the same commit gives the same tarball, with the
same checksum, wherever it is built. That is why the package has no source
map, which would name the directory of the build.

It has no dependencies. Everything the plugin needs that Tabby does not
provide is inside `dist/index.js`, so libraries that are bundled belong in
`devDependencies`.

To try the package the way Tabby installs it, pack it and install the tarball
into an empty directory:

```sh
npm pack
npm install --prefix "$(mktemp -d)" ./tabby-et-<version>.tgz
```

## The first release

npm can only be told to trust a workflow for a package that exists, so the
first version is published by hand, by the account that is to own the package.
That account needs two-factor authentication.

```sh
npm whoami
npm publish --access public
```

`npm publish` asks for the one-time password. It publishes under `latest`.

Then tag the commit that was published, and push:

```sh
git tag -a v1.0.0 -m "tabby-et 1.0.0"
git push origin main
git push origin v1.0.0
```

The tag starts the publish workflow. It finds the version on npm already, and
publishes nothing.

## Trusting the publish workflow

Once the package exists, npm can be told to trust the workflow. From the
command line, with npm 11.15 or later, logged in as an owner of the package:

```sh
npm trust github tabby-et --file publish.yml --repository qoke/tabby-et --allow-publish
npm trust list tabby-et
```

Or on npmjs.com: open the package `tabby-et`, then Settings, then Trusted
Publisher, and choose GitHub Actions:

| Field | Value |
| --- | --- |
| Organization or user | `qoke` |
| Repository | `tabby-et` |
| Workflow filename | `publish.yml` |
| Environment name | leave empty |

The filename is that of `.github/workflows/publish.yml`, without its
directory. If the file is renamed, npm has to be told the new name. A package
has one trusted publisher at a time: to change it, revoke the one it has with
`npm trust revoke tabby-et --id <id>`, and create another.

After the first release through the workflow has worked, publishing access of
the package can be set to require two-factor authentication and disallow
tokens. The workflow needs no token.

## Later releases

```sh
npm version patch --no-git-tag-version   # or minor, or major
git commit -am "Release $(node -p "require('./package.json').version")"
git push origin main
git tag -a "v$(node -p "require('./package.json').version")" -m "tabby-et $(node -p "require('./package.json').version")"
git push origin --tags
```

The workflow checks that the tag is the version in `package.json`, runs the
tests, builds, and publishes with provenance. Started by hand from the Actions
tab, it does all of that except publish.

Only tags of the form `v1.2.3` start it. A pre-release is published by hand,
under a tag of its own, so that `latest` stays what Tabby should install:

```sh
npm publish --access public --tag next
```

## Checks after a release

```sh
npm view tabby-et version keywords dist-tags
npm install --prefix "$(mktemp -d)" tabby-et
```

Tabby's search has to return the package. This is the request Tabby makes
when `et` is typed into the search field:

```
https://registry.npmjs.com/-/v1/search?text=keywords%3Atabby-plugin%20et&size=250
```

The search index can take some minutes to catch up with a new package.

Then, in a Tabby build that has the SSH API changes: Settings, Plugins,
Available, find **et**, click Get, restart Tabby, and connect with an
Eternal Terminal profile.

## If a release is bad

A version cannot be published twice. Publish a fixed version with a higher
number. `npm deprecate tabby-et@<version> "<reason>"` warns whoever installs
the bad one. `npm unpublish` is only possible for a short time after
publishing, and the version number stays used.

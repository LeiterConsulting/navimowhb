# Publishing Checklist

This repository is ready for npm packaging, but a clean public release still benefits from a short checklist.

## What Homebridge Actually Uses

For the main Homebridge Plugins page:

- `displayName` can come from the local installed package metadata
- plugin author is populated from npm registry metadata or Homebridge plugin-list overrides
- plugin card icons come from the Homebridge maintained plugin list for verified plugins, not from local package assets

That means:

- publishing to npm is the correct step if you want the plugin card author to populate
- publishing to npm alone will not make the main Plugins card use a custom Navimow icon
- the custom plugin UI branding in `homebridge-ui/` remains fully under this repository's control

## Pre-Publish Checklist

1. Confirm `package.json` metadata is current
   - `name`
   - `displayName`
   - `description`
   - `homepage`
   - `repository.url`
   - `bugs.url`
   - `keywords`
   - `engines.homebridge`
   - `engines.node`
2. Make sure the compiled output is current
   - `npm run build`
3. Validate the published tarball contents
   - `npm publish --dry-run`
4. Confirm the GitHub repository has issues enabled
5. Create release notes for the version you are publishing
6. Decide on a repository license if the package will be publicly distributed

## Release Commands

Patch release:

```bash
npm version patch --no-git-tag-version
```

Minor release:

```bash
npm version minor --no-git-tag-version
```

Major release:

```bash
npm version major --no-git-tag-version
```

If you want npm to create a git commit and tag for you, omit `--no-git-tag-version`.

Dry run the publish:

```bash
npm publish --dry-run
```

Publish to npm:

```bash
npm publish
```

## Homebridge Verification Readiness

Current state:

- dynamic platform plugin
- config schema implemented
- custom Homebridge UI implemented
- GitHub repo and issues links present in package metadata
- package contents constrained with the `files` allowlist
- no postinstall script

Items to handle outside this repository before requesting verification:

- publish the package to npm
- create GitHub releases with release notes for published versions
- verify the plugin works cleanly on the Homebridge and Node.js versions you plan to support
- if you want a custom icon on the main Homebridge Plugins page, pursue the Homebridge verified/plugin-list path
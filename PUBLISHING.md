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
- GitHub-facing docs should use the committed PNG branding asset instead of the SVG path when exact artwork fidelity matters

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
3. Run the local validation gate
   - `npm run check`
4. Validate the published tarball contents
   - `npm publish --dry-run`
5. Confirm the GitHub repository has issues enabled
6. Create release notes for the version you are publishing
7. Confirm npm is serving the expected version after publish
   - `npm view homebridge-navimow version dist-tags --json`
8. Decide on a repository license if the package will be publicly distributed

Do not treat a successful `npm publish` exit code as the final check. The publish is only complete when `npm view homebridge-navimow version dist-tags --json` shows the version you intended to release.

## Release Commands

Patch release:

```bash
npm run release:patch
```

Minor release:

```bash
npm run release:minor
```

Major release:

```bash
npm run release:major
```

These commands create the version commit and git tag for you.

Dry run the publish:

```bash
npm publish --dry-run
```

Run the local gate first:

```bash
npm run check
```

Publish to npm:

```bash
npm publish
```

Confirm the registry has updated:

```bash
npm view homebridge-navimow version dist-tags --json
```

Create the GitHub release from the matching git tag before or immediately after the npm publish so the repository history stays aligned with the package history.

## Homebridge Verification Readiness

Current state:

- dynamic platform plugin
- config schema implemented
- custom Homebridge UI implemented
- GitHub repo and issues links present in package metadata
- package contents constrained with the `files` allowlist
- local TypeScript linting and prepublish validation in place
- no postinstall script

Items to handle outside this repository before requesting verification:

- publish the package to npm
- create GitHub releases with release notes for published versions
- verify the plugin works cleanly on the Homebridge and Node.js versions you plan to support
- if you want a custom icon on the main Homebridge Plugins page, pursue the Homebridge verified/plugin-list path
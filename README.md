# DSH Usage Plugin

Shareable DeepSeek Harness (DSH) plugin bundle published on npm as:

`@holyknight101/dsh-usage-plugin`

---

## Install (DSH users)

```bash
dsh plugin --profile demo add @holyknight101/dsh-usage-plugin
```

Verify layer:

```bash
dsh --profile demo --dump-config
```

Run DSH with profile:

```bash
dsh --profile demo
```

Remove plugin:

```bash
dsh plugin --profile demo remove @holyknight101/dsh-usage-plugin
```

---

## What this package is

This project is a **DSH bundle package** using `dsh.bundle.patch` to contribute a config layer.

Typical files:

```text
dsh-usage/
├── package.json
├── cordis.patch.yml
└── index.js
```

---

## Minimal bundle manifest (`package.json`)

```json
{
  "name": "@holyknight101/dsh-usage-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml", "README.md", "CHANGELOG.md"],
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

---

## Example plugin entry (`index.js`)

```js
export const name = '@holyknight101/dsh-usage-plugin'

export function apply() {
  console.log('[@holyknight101/dsh-usage-plugin] loaded')
}
```

---

## Example patch layer (`cordis.patch.yml`)

```yaml
- insert:
    - id: dsh-usage
      name: '@holyknight101/dsh-usage-plugin'
```

---

## Publish (maintainer)

```bash
npm login
npm publish --access public
```

---

## Quick troubleshooting

### Plugin not active
- Run `dsh --profile demo --dump-config`
- Confirm bundle layer appears
- Confirm package has `dsh.bundle.patch`

### Install fails
- Confirm package name is exact:
  `@holyknight101/dsh-usage-plugin`
- Confirm internet/npm registry access

### Wrong profile behavior
- Ensure you launch with the same profile used for install:
  `dsh --profile demo`

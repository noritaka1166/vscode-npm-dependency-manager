# npm-dependency-manager

npm-dependency-manager helps you inspect npm dependencies without leaving VS Code. It finds `package.json` files in the current workspace, shows the selected package list in the activity bar, and opens a richer dashboard in the editor for updates, lockfile data, README content, downloads, and security signals.

## Features

- Finds workspace `package.json` files and prefers the workspace root `package.json` by default.
- Shows only the selected `package.json` dependencies in the sidebar.
- Expands packages in the sidebar to browse transitive dependencies from npm registry metadata.
- Searches package names and descriptions without refetching registry data.
- Filters by `dependencies`, `devDependencies`, vulnerable packages, deprecated packages, unknown audit state, healthy packages, and update candidates.
- Compares the requested version, package-lock resolved version, latest version, and publish dates.
- Highlights major, minor, and patch update candidates.
- Runs guarded update actions from the list or package detail page with a confirmation prompt.
- Reads `package-lock.json` for resolved versions, lock paths, and dependency tree context.
- Checks npm audit bulk advisories for direct and transitive vulnerabilities when a resolved version is available.
- Shows deprecated package messages from npm registry metadata.
- Opens a polished package detail page with npm metadata, weekly downloads, links, security information, lockfile context, dependencies, and rendered README content.
- Falls back to GitHub README files when the npm registry does not publish useful README content.
- Opens README external links through VS Code.
- Includes cache controls and explicit refresh actions for registry, audit, README, dependency, and download data.

## Requirements

The extension reads package metadata from the public npm registry and related npm APIs:

- `https://registry.npmjs.org`
- `https://api.npmjs.org`

Some README fallbacks are loaded from repository URLs such as `https://raw.githubusercontent.com` when the npm registry only exposes a README filename or placeholder text.

Vulnerability and dependency tree results are most accurate when a `package-lock.json` exists next to the selected `package.json`.

## Usage

1. Open a Node.js workspace in VS Code.
2. Select the `npm Packages` activity bar view.
3. Pick a `package.json` from the dashboard dropdown when the workspace contains more than one.
4. Use the sticky search and filters to narrow the list.
5. Select a package to open the package detail page.
6. Expand packages in the sidebar to inspect transitive dependencies.

## Commands

- `npm Packages: Show Dashboard`
- `npm Packages: Refresh`
- `npm Packages: Open Package`

## Known Limitations

- npm audit checks require a resolved package version. Add or update `package-lock.json` for packages that show `Vulnerabilities not checked`.
- Transitive vulnerability attribution depends on the dependency graph recorded in `package-lock.json`.
- README rendering supports common npm/GitHub Markdown, but unusual HTML or repository asset layouts may not render exactly like npmjs.com.

# Workspace npm Sidebar

VS Code sidebar extension for browsing dependencies from workspace `package.json` files.

## Features

- Finds `package.json` files in the current workspace, excluding `node_modules` and build output folders.
- Shows only the package list for the selected `package.json` in the sidebar.
- Expands package names in the sidebar to browse their transitive `dependencies` from the npm registry.
- Opens a main editor dashboard when the `npm Packages` sidebar view is selected.
- Lets you select a target `package.json` from the dashboard dropdown.
- Lists `dependencies` and `devDependencies` in the dashboard.
- Filters by dependency type.
- Shows the installed version range, npm latest version, and the newest version published within a configurable week window.
- Opens a package detail view in the main editor with npm registry README content and package metadata.

## Run locally

1. Open this folder in VS Code.
2. Press `F5` and run the `Run Extension` launch configuration.
3. In the Extension Development Host window, open the `npm Packages` activity bar view.

The extension reads npm registry metadata directly from `https://registry.npmjs.org`.

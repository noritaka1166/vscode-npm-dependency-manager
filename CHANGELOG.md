# Change Log

## 0.0.7

- Strengthened README HTML sanitization in the package detail webview with DOMPurify.
- Improved package detail reliability, including safer parsing and resilient handling of optional registry and README data.
- Improved the package detail layout on desktop and narrow windows. README content and package metadata now scroll independently on wider screens.
- Reduced the VSIX package size by excluding development-only source maps and unused DOMPurify builds.

## 0.0.6

- Added automatic npm, pnpm, Yarn, and Bun detection from the `packageManager` field and common lockfiles.
- Updated dependency update actions and install-command hints to use the detected package manager.
- Improved repository links and GitHub README fallbacks by normalizing common repository URL formats, including HTTPS, SSH, and hosted shorthand URLs.
- Hardened audit input handling for dependency names such as `constructor` and `__proto__`.

## 0.0.5

- Improved Marketplace discoverability with a clearer extension description, the Linters category, and expanded npm, security, license, and update-related keywords.
- Redesigned the dependency icon and added it to the Dependencies view.
- Updated `markdown-it` from 14.2.0 to 14.3.0, including the updated `linkify-it` transitive dependency.

## 0.0.4

- Added a column picker for showing and hiding dependency table columns.
- Added resizable dependency table columns with persisted column width preferences.
- Persisted search, dependency type, risk, update, and license filters per workspace.
- Improved loading and empty-state handling while package.json files and dependency data are being scanned.
- Optimized package detail loading by fetching independent metadata, downloads, README fallback, and security data in parallel where possible.
- Optimized security checks by extracting security logic into a dedicated service, improving cache handling, and deferring heavier transitive OSV tree checks to package detail views.
- Simplified VS Code activation metadata and expanded syntax checks to include the extracted security module.

## 0.0.3

- Added OSV vulnerability checks for direct and transitive dependencies.
- Added CVE-linked EPSS and CISA Known Exploited Vulnerabilities signals when available.
- Added OSV, EPSS, and KEV badges to the dependency list and package detail security section.
- Added OSV, EPSS, and KEV cache visibility to the dashboard cache summary.

## 0.0.2

- Added update actions for outdated dependencies from the package list and package detail page.
- Added a confirmation prompt before running npm update commands.
- Added a copy-command path for reviewing or running the generated npm install command manually.
- Added license values to the dependency list.
- Added a license filter populated from licenses detected in the selected package.json.
- Added unknown-license handling for packages that do not publish license metadata.

## 0.0.1

Initial Marketplace-ready release.

- Added workspace `package.json` discovery and root package preference.
- Added sidebar dependency browsing with expandable transitive dependencies.
- Added editor dashboard with dependency filters, search, update candidates, publish dates, cache controls, and refresh actions.
- Added package-lock integration for resolved versions, lock paths, and dependency tree context.
- Added npm audit bulk advisory checks for direct and transitive vulnerabilities.
- Added deprecated package detection.
- Added package detail pages with rendered README content, npm metadata, weekly downloads, links, security information, and dependency details.

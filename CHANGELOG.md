# Change Log

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

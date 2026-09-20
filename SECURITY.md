# Security Policy

## Supported Versions

Security fixes are provided for the latest released version of this extension.

## Reporting a Vulnerability

Please report suspected vulnerabilities privately through GitHub Security Advisories:

https://github.com/noritaka1166/vscode-npm-dependency-manager/security/advisories

If private reporting is unavailable, do not include exploit details, credentials, or other sensitive information in a public issue. Contact the maintainer through GitHub and request a private reporting channel.

Please include:

- A description of the issue and its potential impact
- Reproduction steps or a minimal proof of concept
- The extension and VS Code versions
- Any relevant package-manager, operating-system, or workspace details

We will acknowledge reports, assess their impact and reachability, and coordinate a fix and disclosure as appropriate.

## Security Scope

Relevant issues include, but are not limited to:

- Execution of unintended commands or command injection during dependency updates
- Reading, writing, or exposing files outside the selected workspace project
- Disclosure of credentials, tokens, or private workspace data
- Unsafe handling of package metadata, README content, repository URLs, or external links
- Incorrect handling of data received from npm, OSV, GitHub, or other vulnerability-intelligence services
- Bypasses of the extension's workspace-trust or update-confirmation safeguards

## Out of Scope

The following are normally out of scope unless they result from a flaw in this extension:

- Vulnerabilities in third-party packages or public services that this extension reports
- Incorrect or incomplete vulnerability, license, package, download, EPSS, or KEV data supplied by upstream services
- Availability failures of external registries and vulnerability-intelligence services
- Social-engineering attacks or reports requiring access to a user's local VS Code session

## Security Considerations

The extension sends package names and resolved package versions to public package and vulnerability-intelligence services when the related features are used. It does not intentionally upload workspace source files, `.npmrc` files, environment variables, authentication tokens, or other credentials.

# Security notes

This is a personal development fork. It is not independently security-audited and has no promised response SLA. Known dependency findings and browser verification gaps are documented in [the publication review](docs/PUBLICATION_REVIEW.md).

## Reporting

Never post API keys, browser storage dumps, unredacted HARs or private webpage text in public issues. Use GitHub's private vulnerability reporting on the fork if its owner has enabled it. If no private reporting channel is available, first ask for a private contact without disclosing exploit details or credentials. The upstream maintainer is not responsible for this fork's changes.

For suspected credential exposure, revoke the credential at its issuer immediately. Removing a file or deleting a commit does not revoke a key or remove already-copied data.

## Boundaries

Background owns Relay credentials and network requests. Page scripts cannot choose the Relay URL or retrieve the raw key through extension messages. Firefox persistent credentials use extension-origin IndexedDB, not unprotected `storage.local`; Chrome uses session storage or restricted local storage. These boundaries do not protect against local malware, a copied browser profile, or compromise of the extension itself.

Translation sends webpage text to the configured Relay, including eligible new content while automatic translation is enabled. The Relay's logging, retention and billing are outside this repository's control. Read [privacy notes](docs/privacy.md) before translating private account pages.

Use a separate test browser profile, loopback Mock Relay and fake credentials for contributions. Do not change dependency versions, request retry semantics or credential boundaries without corresponding review and regression tests.

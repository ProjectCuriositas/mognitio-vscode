# Changelog

## 0.1.2

- Keep the standalone language server running as documents are added or removed, with exact per-document routing and stale-result rejection during workspace transfers.
- Name sessions omitted by the window budget and explain unsupported environments in the Output channel without repeated warnings.
- Log the verified server version after connection and recover lexical highlighting at the end of an unterminated string's line.

- Accept the formal Mognitio 1.1.0 language server while retaining 0.15.x and 1.0.0 support.
- Continue rejecting unverified versions, prereleases and build-metadata variants in production.
- Reject malformed legacy server versions with a trailing line terminator.
- Preserve exact development-identity checks, editor capabilities and platform requirements.

## 0.1.1

- Accept the formal Mognitio 1.0.0 language server while retaining 0.15.x support.
- Keep exact development-identity checks and reject unverified future versions,
  prereleases and build-metadata variants in production.
- No change to editor capabilities, minimum VS Code, publisher or platform scope.

## 0.1.0

First stable release under the Mognitio publisher (`mognitio.mognitio`).
The GitHub-only preview used `ProjectCuriositas.mognitio`; uninstall that preview
before installing this release so only one language client runs. Future extension
releases use a new extension version independently of the compiler.

Initial Mognitio language support: file association, lexical and semantic
highlighting, diagnostics, and explicit language server restart.

- Compatible language server: formal Mognitio 0.15.x.
- Minimum VS Code: 1.91.0.
- Supported platform: Linux amd64 desktop (Ubuntu 24.04 and 26.04).
- Extension versioning and releases are independent of the language toolchain.

- Reject diagnostics from an older open-document version before conversion and
  immediately before display, retaining the latest receive order per URI.

- Keep manifest diagnostics hidden after a disk-changing save until a new publish;
  restore cached positions only after disk-unchanged discard.

- Order manifest diagnostic conversion against disk observations at receipt,
  preventing a conversion started before save from restoring old positions.

- Preserve in-flight manifest diagnostics across edits that leave disk unchanged,
  while waiting for pending disk observations and rejecting changed generations.

- Establish each manifest notification's first-hash baseline from observations
  after receipt, retaining new saved-content diagnostics while disk state catches up.

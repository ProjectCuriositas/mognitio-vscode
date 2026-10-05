# Changelog

## 0.1.0 — unreleased

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

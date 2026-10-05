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

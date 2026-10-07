# Mognitio for Visual Studio Code

Open-source language support for Mognitio, maintained independently of the
compiler and language server.

## Compatibility

| Extension | Mognitio language server | VS Code | Platform |
|---|---|---|---|
| 0.1.2 | 0.15.x formal releases, 1.0.0 and 1.1.0 | 1.91.0 or later | Linux amd64 desktop; Ubuntu 24.04 and 26.04 |

Extension versions and language versions are independent. Development toolchains
and versions outside the listed range are rejected by the distributed extension.
Remote-SSH, WSL, web, and virtual workspaces are not supported in this version.
The compatibility table describes the supported contract; see release notes for
published artifacts and completed validation.

## Features

- Associate .mgn files with Mognitio.
- Lexical highlighting, comments, brackets, and language configuration.
- Semantic highlighting and Problems from the shared Mognitio language server.
- Unsaved source analysis, dependency refresh, and multiple project folders.
- Syntax diagnostics for standalone saved files.

The extension does not bundle or download a compiler. Install a compatible
Mognitio toolchain separately. Make mognitio-lsp available on PATH, or set
mognitio.serverPath to its absolute executable path in User settings.
Workspace settings cannot select an executable.

Install **Mognitio** by the **Mognitio** publisher (`mognitio.mognitio`) from the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=mognitio.mognitio),
or install the exact VSIX from [GitHub Releases](https://github.com/ProjectCuriositas/mognitio-vscode/releases)
with **Extensions: Install from VSIX**.

The GitHub-only preview used the separate ID `ProjectCuriositas.mognitio`.
Uninstall that preview before installing the stable extension; it is not an
in-place Marketplace upgrade. Stable extension versions evolve independently
of compiler versions. Release assets and their checksums are immutable.

Open a project folder containing mognitio.toml and src/. Semantic analysis
requires workspace trust; untrusted workspaces retain lexical highlighting.
At most four language server sessions run per window, including a shared
standalone-file session. Overlapping source roots are rejected.
The server checks source files without running project entry points or tests.

Use **Mognitio: Restart Language Server** after resolving launch or server
failures. Details appear in the **Mognitio** Output channel.
VS Code's editor.semanticHighlighting.enabled setting controls semantic
highlighting independently of diagnostics.

## Development

Run npm ci, npm run check, npm test, and npm run package.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution, validation, independent
versioning, and release rules. See [CHANGELOG.md](CHANGELOG.md) for extension
changes and [LICENSE](LICENSE) for the MIT license.

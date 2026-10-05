# Contributing

Write pull request titles and descriptions in English. Keep repository
documentation and code comments in English as well.

Describe the problem, resulting behavior, and relevant validation so a reader
can review the change without access to private discussions or documents.
Use repository-relative paths and examples that work in an ordinary checkout.

Keep public contributions free of personal or machine-specific context:

- Do not include personal names, usernames, hostnames, IP addresses, credentials,
  private repository references, or local installation paths.
- Do not copy private specifications, chat transcripts, machine setup notes,
  or agent session history into a pull request or repository file.
- Describe prerequisites and platform constraints as project requirements.
  Do not frame instructions around a contributor's personal workstation.
- Review logs, screenshots, and generated artifacts for private information
  before including them.

## Validation

Run the checks appropriate to the change. Client or test changes should run:

```sh
npm ci
npm run check
npm test
npm run package
git diff --check
```

For documentation-only changes, check relative links, code fences, and
whitespace. Report commands, outcomes, and any unverified behavior honestly.
Use sanitized summaries when raw output contains local paths or other
machine-specific details.

Use Node.js 24 for development and the integration runner. The bundled client
targets the Node.js runtime provided by the minimum supported VS Code version.
Run the integration checks on VS Code 1.91.0 and a supported Linux desktop with
a display (a headless X server is sufficient):

- Set MOGNITIO_TEST_SERVER to a compatible server executable.
- Set MOGNITIO_TEST_VSIX to the packaged VSIX, then run npm run integration.
- Repeat with MOGNITIO_TEST_UNTRUSTED=1 to check Restricted Mode in a normal window.
- Repeat with MOGNITIO_TEST_DELAY_DIAGNOSTICS=1 to delay real diagnostics in FIFO
  order until the target document changes and verify that stale errors never appear.
- For development toolchains only, omit MOGNITIO_TEST_VSIX and explicitly set
  MOGNITIO_EXPECTED_IDENTITY to the generated identity.json.

The tests observe actual semantic colors through the editor renderer, alongside
Extension Host diagnostics and dependency events. Renderer evidence is stored
under the ignored .vscode-test/evidence directory. Development identity overrides
are disabled for production installations.
Do not infer editor behavior from type checking alone.

## Change and release workflow

Use short-lived feature branches such as feat/initial-language-support and
pull requests targeting main. Squash reviewed and verified pull requests into
main, then delete the merged feature branch. Do not push directly to main.
The extension does not use compiler milestone branches such as mognitio/v015.

Version the extension independently using SemVer in package.json and the lockfile.
A language release does not automatically change the extension version. Record
supported language server versions in the README compatibility table and keep
the runtime compatibility check and its tests consistent with that table.
Update the extension version for extension changes according to its own API and
compatibility impact. Record those changes in CHANGELOG.md.

Merging a feature is not a release. Publish an immutable extension version tag,
GitHub Release, VSIX release, or Marketplace update only after explicit approval
for that extension release. Language release approval does not automatically
authorize a Marketplace publication.

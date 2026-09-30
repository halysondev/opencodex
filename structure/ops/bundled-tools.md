# Bundled command tools

OpenCodex includes RTK as a native executable and exposes it through `ocx rtk <args...>`.
`src/rtk/assets.ts` declares the source commit, release version, five supported targets,
archive sizes and SHA-256 digests, and extracted executable sizes and digests.

`scripts/prepare-rtk.ts` downloads only those declared release artifacts while assembling
packages. It verifies the archive before decoding, reads only the exact executable member,
verifies that member, and writes it atomically into a generated bin subtree of `vendor/rtk`. Generated directory
symlinks are rejected. No archive entry chooses a filesystem destination. Source archives
are cached under `.tmp/rtk-archives` and are verified again before reuse.

`scripts/prepare-package.ts` prepares every target for npm and normalizes executable modes.
`scripts/build-standalone.ts` stages only its target, with LICENSE and NOTICE, under `rtk/`.
`desktop/scripts/prepare-sidecar.ts` copies that tree into desktop resources; universal macOS
preparation retains both architecture directories. Release archives include the RTK tree,
and macOS distribution signs its executables together with other nested native code.
Signing can change executable bytes after their upstream provenance has been verified.

`src/rtk/bundle.ts` resolves source/npm binaries inside the package and compiled binaries
through `src/lib/packaged-resources.ts`. The same helper preserves the existing keyring
resource layouts: executable-relative standalone folders, macOS Contents/Resources, and
Linux usr/lib/OpenCodex. Resolution never searches PATH or cwd and never downloads a file.
A missing, linked, or non-executable entry fails with an installation error.

`src/cli/root.ts` leaves RTK's arguments intact and bypasses Codex-shim preflight for this
command. `src/cli/rtk.ts` forwards an argument vector, inherited stdio, child exit status,
and interruption signals. It does not create proxy configuration or initialize global
agent hooks. RTK itself owns the behavior and state of the explicitly delegated command.

Coverage lives in `tests/cli/cli-rtk.test.ts`, `tests/cli/rtk-bundle.test.ts`, and
`tests/ci-workflows/rtk-packaging.test.ts`. Release smoke checks execute the packaged RTK;
tests of path construction alone do not prove execution on another operating system.

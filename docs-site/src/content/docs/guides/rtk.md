---
title: Built-in RTK
description: Filter command output with the RTK executable included in OpenCodex.
---

OpenCodex includes [RTK](https://github.com/rtk-ai/rtk), a command-output filter that reduces
the text a coding agent needs to read. A separate RTK installation is not required.

```bash
ocx rtk --version
ocx rtk git status
ocx rtk git diff
ocx rtk rg "pattern" src
ocx rtk --help
```

Arguments are passed directly to RTK. The command keeps its normal input, output, errors,
and exit code, so it can be used in scripts and coding-agent command instructions.
Use `ocx rtk` wherever you would otherwise use the `rtk` command prefix.

The npm package, standalone archives, and desktop installers contain the executable for
their supported platform. RTK is ready when OpenCodex is installed; running it does not
download another tool. Existing RTK settings remain owned by RTK. Installing OpenCodex does
not automatically change agent hooks or replace a separately installed `rtk` command.

RTK is distributed under Apache-2.0. Its license and notices are included with each package.
For a source checkout, `bun run prepare:rtk` assembles the pinned executables before use.

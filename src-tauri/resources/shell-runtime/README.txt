Place bundled shell runtimes in this folder to enable embedded bash/zsh without system installs.

Expected examples on Windows:
- resources/shell-runtime/bin/bash.exe
- resources/shell-runtime/bin/zsh.exe
- resources/shell-runtime/usr/bin/bash.exe
- resources/shell-runtime/usr/bin/zsh.exe

At runtime, the app will try bundled binaries here first, then system PATH, then WSL fallback.
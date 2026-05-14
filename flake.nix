{
  description = "ECHO Next — HiFi desktop music player";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config = { allowUnfree = true; };
        };

        # ------------------------------------------------------------------
        # Electron needs a versioned Node.js. sharp and better-sqlite3 compile
        # native addons, so the dev shell must expose the same toolchain that
        # electron-rebuild expects.
        # ------------------------------------------------------------------
        nodejs = pkgs.nodejs_20;

        # Electron runtime libraries — needed so the prebuilt Electron binary
        # can find its shared objects at run time inside a Nix shell.
        electronLibs = with pkgs; [
          alsa-lib
          at-spi2-atk
          atk
          cairo
          cups
          dbus
          expat
          gdk-pixbuf
          glib
          gtk3
          libdrm
          libxcb
          libxkbcommon
          libx11
          libxcomposite
          libxdamage
          libxext
          libxfixes
          libxrandr
          libxrender
          libxscrnsaver
          libxtst
          mesa
          nspr
          nss
          pango
        ];

        # Native build dependencies for the JUCE audio host.
        audioHostNativeBuildInputs = with pkgs; [
          cmake
          ninja
          pkg-config
        ];

        audioHostBuildInputs = with pkgs; [
          alsa-lib
          libjack2
        ];

        # Dependencies needed for compiling native Node addons
        # (better-sqlite3, sharp).
        nodeNativeBuildInputs = with pkgs; [
          nodejs
          python3
          pkg-config
          glib
        ];

        nodeNativeBuildInputsLibs = with pkgs; [
          vips        # sharp
          sqlite      # better-sqlite3
        ];

        # Merge alsa-lib with PipeWire ALSA plugins so JUCE can open
        # audio devices through PipeWire.
        alsaWithPipewire = pkgs.symlinkJoin {
          name = "alsa-with-pipewire";
          paths = [ pkgs.alsa-lib pkgs.pipewire ];
          postBuild = ''
            mkdir -p "$out/lib/alsa-lib"
            for so in ${pkgs.pipewire}/lib/alsa-lib/*.so; do
              ln -sf "$so" "$out/lib/alsa-lib/"
            done
          '';
        };

        # Everything you need for a full pnpm dev:full session.
        devShell = pkgs.mkShell {
          name = "echo-next-dev";

          nativeBuildInputs =
            audioHostNativeBuildInputs
            ++ nodeNativeBuildInputs
            ++ (with pkgs; [ git pnpm ]);

          buildInputs =
            [ alsaWithPipewire ]
            ++ (with pkgs; [ libjack2 ])
            ++ electronLibs
            ++ nodeNativeBuildInputsLibs
            ++ (with pkgs; [ ffmpeg pipewire ]);

          shellHook = ''
            export ELECTRON_RUN_AS_NODE=0
            export ALSA_PLUGIN_DIR="${alsaWithPipewire}/lib/alsa-lib"
            export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath electronLibs}''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

            echo ""
            echo "╔══════════════════════════════════════════════╗"
            echo "║   ECHO Next — Nix dev shell (pnpm)           ║"
            echo "║──────────────────────────────────────────────║"
            echo "║   pnpm install        ← install deps         ║"
            echo "║   pnpm dev:full       ← full dev mode        ║"
            echo "║   pnpm build:linux    ← production build     ║"
            echo "║   pnpm test           ← run tests            ║"
            echo "╚══════════════════════════════════════════════╝"
            echo ""
          '';
        };

        # ------------------------------------------------------------------
        # Build the application. Runs the full build pipeline inside a Nix
        # derivation, producing an AppImage.
        # ------------------------------------------------------------------
        app = pkgs.stdenv.mkDerivation {
          pname = "echo-next";
          version =
            let
              pj = builtins.fromJSON (builtins.readFile ./package.json);
            in
              pj.version;

          src = ./.;

          nativeBuildInputs =
            audioHostNativeBuildInputs
            ++ nodeNativeBuildInputs
            ++ (with pkgs; [
              nodejs
              python3
              electron
            ]);

          buildInputs =
            audioHostBuildInputs
            ++ electronLibs
            ++ nodeNativeBuildInputsLibs
            ++ (with pkgs; [ ffmpeg ]);

          # pnpm and electron-gyp need writable $HOME for cache.
          HOME = "/tmp/echo-nix-home";

          configurePhase = ''
            runHook preConfigure

            export HOME="$NIX_BUILD_TOP/pnpm-home"
            mkdir -p "$HOME/.pnpm" "$HOME/.electron-gyp" "$HOME/.cache"

            # Use Nix-provided electron instead of downloading via npm.
            export ELECTRON_SKIP_BINARY_DOWNLOAD=1
            export ELECTRON_OVERRIDE_DIST_PATH="${pkgs.electron}/lib/electron"

            # Let pnpm/electron-rebuild find the electron binary.
            mkdir -p node_modules/.bin
            ln -sf "${pkgs.electron}/bin/electron" node_modules/.bin/electron

            runHook postConfigure
          '';

          buildPhase = ''
            runHook preBuild

            pnpm install --frozen-lockfile --ignore-scripts
            pnpm rebuild better-sqlite3
            pnpm rebuild sharp

            # Build the native JUCE audio host.
            pnpm build:audio-host

            # Type-check and bundle with electron-vite.
            pnpm build

            # Package as AppImage + deb (linux targets only).
            pnpm exec electron-builder --linux --config package.json

            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p "$out/share/echo-next"
            cp -r dist/*.AppImage "$out/share/echo-next/" 2>/dev/null || true
            cp -r dist/*.deb       "$out/share/echo-next/" 2>/dev/null || true

            # Also install an unwrapped copy that can be run directly
            # (useful for debugging).
            mkdir -p "$out/lib/echo-next"
            cp -r dist/linux-unpacked/* "$out/lib/echo-next/" 2>/dev/null || true
            runHook postInstall
          '';

          meta = with pkgs.lib; {
            description = "ECHO Next — HiFi desktop music player";
            homepage = "https://github.com/echo-next/ECHO-Next";
            license = licenses.gpl3Only;
            platforms = platforms.linux;
            mainProgram = "echo-next";
          };
        };

      in
        {
          packages = {
            default = app;
            echo-next = app;
          };

          devShells = {
            default = devShell;
            echo-next = devShell;
          };

          # Convenience apps entry (nix run .#)
          apps.default = flake-utils.lib.mkApp {
            drv = app;
            name = "echo-next";
          };
        }
    );
}

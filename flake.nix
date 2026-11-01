{
  description = "Magnixify - GNOME Shell extension magnifier - better accessibility.";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      version = "1.0.0";
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in {
          default = pkgs.runCommand "magnixify-${version}" {
            inherit version;
          } ''
            mkdir -p "$out/share/gnome-shell/extensions/magnixify@quackhack-mcblindy.com"
            cp -r ${builtins.path {
              path = ./.;
              name = "magnixify-source";
            }}/magnixify@quackhack-mcblindy.com/. \
              "$out/share/gnome-shell/extensions/magnixify@quackhack-mcblindy.com/"
          '';
        });
        
    };}

{
  description = "Magnixify - Gnome magnifier.";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      uuid = "magnixify@quackhack-mc-blindy.com";
      systems = [ "x86_64-linux" "aarch64-linux" ];
    in {
      packages = nixpkgs.lib.genAttrs systems (system:
        let pkgs = nixpkgs.legacyPackages.${system}; in {
          default = pkgs.stdenvNoCC.mkDerivation {
            pname = "magnixify";
            version = "0.1.0";
            src = ./.;
            dontBuild = true;
            installPhase = ''
              mkdir -p $out/share/gnome-shell/extensions/${uuid}
              cp -r ${uuid}/* $out/share/gnome-shell/extensions/${uuid}/
            '';
          };
        });
        
    };}

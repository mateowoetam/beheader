{
  description = "A Flake providing everything needed to run Beheader";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    cachix.url = "github:cachix/cachix";
  };
  outputs =
    {
      self,
      nixpkgs,
      cachix,
      ...
    }@inputs:
    {
      nixosConfigurations = flake-utils.lib.forAllSystems (system: {
        inherit system;
        specialArgs = { inherit inputs; };
        configuration = {
          environment.systemPackages = with nixpkgs.pkgs; [
            ffmpeg
            imagemagick
            zip
            unzip
            bun
            bento4
          ];
        };
      });
    };
}

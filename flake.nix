{
  description = "MindCraft flake";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
  };

  outputs = {
    nixpkgs,
    ...
  }:
  let
    pkgs = nixpkgs.legacyPackages.x86_64-linux;
  in {
    devShell = pkgs.mkShell {
      buildInputs = with pkgs; [
        nodejs_20
        libX11
				libXext
				libuuid
      ];
			# shellHook = ''
			# 	export LD_LIBRARY_PATH="${pkgs.libX11}/lib:${pkgs.libXext}/lib:$LD_LIBRARY_PATH"
			# '';
			env = {
				LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [
					pkgs.libX11
					pkgs.libXext
					pkgs.libuuid
				];
			};
    };
  };
}

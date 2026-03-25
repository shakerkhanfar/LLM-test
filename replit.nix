{ pkgs }: {
  deps = [
    pkgs.nodejs_20
    pkgs.postgresql
    pkgs.openssl
  ];
}

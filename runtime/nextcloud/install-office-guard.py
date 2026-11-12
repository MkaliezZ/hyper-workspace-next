#!/usr/bin/env python3
"""Stage our NC 33 companion app and a private, explicit gateway configuration."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
from urllib.parse import urlsplit


def settings(secret_file, gateway_url, gateway_ips, member_group):
    try:
        secret = Path(secret_file).read_text(encoding="ascii").strip()
    except (OSError, UnicodeError) as exc:
        raise ValueError("The private guard secret file is unavailable") from None
    if not re.fullmatch(r"[a-f0-9]{64}", secret):
        raise ValueError("The guard secret must contain 64 lowercase hexadecimal characters")
    try:
        address = urlsplit(gateway_url)
        valid = (address.scheme in ("http", "https") and address.hostname == "office-gateway"
                 and address.port == 9982 and address.path in ("", "/")
                 and not address.query and not address.fragment
                 and address.username is None and address.password is None)
    except ValueError:
        valid = False
    if not valid:
        raise ValueError("Use the fixed internal office-gateway control endpoint on port 9982")
    peers = []
    for candidate in gateway_ips:
        try:
            peer = ipaddress.ip_address(candidate)
        except ValueError:
            raise ValueError("A gateway peer address is invalid") from None
        if peer.is_loopback or peer.is_multicast or peer.is_unspecified or "%" in candidate:
            raise ValueError("Use an explicit gateway container address")
        if str(peer) not in peers:
            peers.append(str(peer))
    if not peers or not member_group or len(member_group.encode("utf8")) > 256 or any(ord(c) < 32 for c in member_group):
        raise ValueError("Explicit gateway peers and the workspace member group are required")
    return {"gateway_url": gateway_url.rstrip("/"), "gateway_ips": peers,
            "secret": secret, "member_group": member_group}


def php_config(value):
    encoded = json.dumps(value, ensure_ascii=True, separators=(",", ":")).replace("\\", "\\\\").replace("'", "\\'")
    return "<?php\ndeclare(strict_types=1);\n$CONFIG = ['hyper_office_guard' => json_decode('" + encoded + "', true, 16, JSON_THROW_ON_ERROR)];\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--secret-file", required=True)
    parser.add_argument("--gateway-url", required=True)
    parser.add_argument("--gateway-ip", action="append", required=True)
    parser.add_argument("--member-group", required=True)
    args = parser.parse_args()
    try:
        value = settings(args.secret_file, args.gateway_url, args.gateway_ip, args.member_group)
        root = Path(__file__).resolve().parents[2]
        output = root / ".runtime" / "nextcloud"
        output.mkdir(parents=True, exist_ok=True)
        if not output.resolve().is_relative_to(root):
            raise ValueError("The staging directory must stay inside this checkout")
        app = output / "hyper_office_guard"
        if app.is_symlink():
            raise ValueError("The companion app staging path must not be a symlink")
        if app.exists():
            if app.resolve().parent != output.resolve():
                raise ValueError("The companion app staging path is invalid")
            shutil.rmtree(app)
        shutil.copytree(root / "runtime" / "nextcloud" / "hyper_office_guard", app)
        target = output / "zz-hyper-office-guard.config.php"
        if target.is_symlink():
            raise ValueError("The private configuration path must not be a symlink")
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o640)
        with os.fdopen(descriptor, "w", encoding="utf8", newline="\n") as stream:
            stream.write(php_config(value))
        os.chmod(target, 0o640)
        print("Office companion app and private gateway configuration staged")
    except (ValueError, OSError) as exc:
        # Validation errors are fixed messages; never print an OS path or contents.
        parser.exit(1, "Office guard staging failed: invalid or unavailable private configuration\n")


if __name__ == "__main__":
    main()

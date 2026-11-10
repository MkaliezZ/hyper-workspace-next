"""Generate a narrowly scoped Nextcloud settings callback configuration."""
import argparse
import ipaddress
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("collabora_ip", type=ipaddress.ip_address)
parser.add_argument("--output", type=Path, default=Path(
    ".runtime/nextcloud/zz-hyper-office-settings.config.php"))
args = parser.parse_args()
if (args.collabora_ip.is_unspecified or args.collabora_ip.is_multicast
        or args.collabora_ip.is_loopback or getattr(args.collabora_ip, "scope_id", None)):
    parser.error("Use the directly connected Collabora container IP")
template = Path(__file__).with_name("office-settings.config.php.in").read_text(encoding="utf-8")
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(template.replace("@COLLABORA_IP@", str(args.collabora_ip)), encoding="utf-8", newline="\n")
print("Generated scoped Office settings callback configuration")

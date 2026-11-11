"""Bootstrap one public apt hostname on disposable CI runners with broken DNS.

Normal system resolution is preferred. The fallback queries Google's HTTPS DNS
JSON API, checks public IPv4 answers, and verifies Ubuntu's HTTPS certificate and
archive response before adding a job-local hosts entry. Apt still verifies its
normal signed repository metadata. No product/source addresses are changed.
https://developers.google.com/speed/public-dns/docs/doh/json
"""
import http.client
import ipaddress
import json
import os
import socket
import ssl
import sys
import urllib.request
from pathlib import Path

HOST = "archive.ubuntu.com"
QUERY = "https://dns.google/resolve?name=archive.ubuntu.com&type=A&edns_client_subnet=0.0.0.0/0"


def addresses(value):
    if not isinstance(value, dict) or value.get("Status") != 0 or value.get("TC") or value.get("CD"):
        raise ValueError("Invalid Ubuntu DNS status")
    questions = value.get("Question", [])
    if questions != [{"name": HOST + ".", "type": 1}] and questions != [{"name": HOST, "type": 1}]:
        raise ValueError("Unexpected Ubuntu DNS question")
    answers = value.get("Answer", [])
    if not isinstance(answers, list) or len(answers) > 32:
        raise ValueError("Invalid Ubuntu DNS answer count")
    found = []
    for answer in answers:
        if not isinstance(answer, dict) or answer.get("type") != 1:
            continue
        ip = ipaddress.IPv4Address(answer.get("data", ""))
        if not ip.is_global:
            raise ValueError("Ubuntu DNS cannot select a private address")
        if str(ip) not in found:
            found.append(str(ip))
    if not found:
        raise ValueError("Ubuntu DNS has no public IPv4 address")
    return found


def verified_address():
    request = urllib.request.Request(QUERY, headers={"Accept": "application/dns-json"})
    with urllib.request.urlopen(request, timeout=15) as response:
        raw = response.read(16385)
        if response.status != 200 or len(raw) > 16384:
            raise ValueError("Invalid Ubuntu DNS response")
    candidates = addresses(json.loads(raw))
    context = ssl.create_default_context()
    for ip in candidates[:8]:
        connection = http.client.HTTPSConnection(HOST, timeout=5, context=context)
        try:
            # Connect to the answer while retaining the original SNI, hostname
            # certificate verification, and HTTP Host; never disable TLS checks.
            transport = socket.create_connection((ip, 443), timeout=5)
            try:
                connection.sock = context.wrap_socket(transport, server_hostname=HOST)
            except Exception:
                transport.close()
                raise
            connection.request("HEAD", "/ubuntu/dists/noble/InRelease")
            if connection.getresponse().status == 200:
                return ip
        except (OSError, http.client.HTTPException):
            pass
        finally:
            connection.close()
    raise RuntimeError("Ubuntu HTTPS archive verification failed")


def main():
    if sys.argv[1:] == ["--probe"]:
        verified_address()
        print("ubuntu_dns_https_probe=verified")
        return
    if sys.argv[1:]:
        raise ValueError("Only --probe is supported")
    if os.environ.get("GITHUB_ACTIONS") != "true" or sys.platform != "linux":
        raise ValueError("Host-file bootstrap is restricted to Linux GitHub Actions")
    try:
        socket.getaddrinfo(HOST, 443, family=socket.AF_INET, type=socket.SOCK_STREAM)
        print("ubuntu_dns=system")
        return
    except socket.gaierror:
        pass
    ip = verified_address()
    with Path("/etc/hosts").open("a", encoding="ascii") as output:
        output.write("\n" + ip + " " + HOST + " # hyper-ci-ubuntu-dns\n")
    observed = socket.getaddrinfo(HOST, 443, family=socket.AF_INET, type=socket.SOCK_STREAM)
    if not any(value[4][0] == ip for value in observed):
        raise RuntimeError("Ubuntu DNS bootstrap was not applied")
    print("ubuntu_dns=https_bootstrap_verified")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Provider payloads and environment/proxy details do not enter CI logs.
        print("ubuntu_dns=failed error=" + type(error).__name__, file=sys.stderr)
        sys.exit(1)

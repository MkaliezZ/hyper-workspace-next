"""Pure configuration-boundary checks; does not stage or alter live credentials."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("office_guard_installer", Path(__file__).parents[2] / "runtime/nextcloud/install-office-guard.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerBoundaries(unittest.TestCase):
    def test_private_endpoint_peers_and_literal_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            secret = Path(directory) / "secret"
            secret.write_text("a" * 64 + "\n", encoding="ascii")
            value = installer.settings(secret, "http://office-gateway:9982", ["172.18.0.4", "172.18.0.4"], "group's \\ name")
            self.assertEqual(value["gateway_ips"], ["172.18.0.4"])
            rendered = installer.php_config(value)
            self.assertIn("json_decode('", rendered)
            self.assertIn("JSON_THROW_ON_ERROR", rendered)
            for endpoint in ("http://example.com:9982", "http://office-gateway:9981", "http://x@office-gateway:9982", "http://office-gateway:9982/?x=1", "http://office-gateway:9982/#x"):
                with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                    installer.settings(secret, endpoint, ["172.18.0.4"], "hyper-members")
            for peer in ("127.0.0.1", "::", "224.0.0.1", "fe80::1%eth0", "not-an-ip"):
                with self.subTest(peer=peer), self.assertRaises(ValueError):
                    installer.settings(secret, "http://office-gateway:9982", [peer], "hyper-members")
            secret.write_text("invalid", encoding="ascii")
            with self.assertRaises(ValueError):
                installer.settings(secret, "http://office-gateway:9982", ["172.18.0.4"], "hyper-members")


if __name__ == "__main__":
    unittest.main()

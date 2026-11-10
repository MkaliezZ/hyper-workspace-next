import subprocess
import sys
import tempfile
from pathlib import Path
import unittest


GENERATOR = Path(__file__).with_name("office-settings.py")


class OfficeSettingsGeneratorTest(unittest.TestCase):
    def test_nonpeer_or_scoped_addresses_cannot_enter_php_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "settings.php"
            for value in ["0.0.0.0", "127.0.0.1", "::1", "224.0.0.1",
                          "fe80::1%interface", "fe80::1%x';exit;//", "not-an-ip"]:
                result = subprocess.run(
                    [sys.executable, str(GENERATOR), value, "--output", str(output)],
                    capture_output=True,
                )
                self.assertNotEqual(result.returncode, 0, value)
                self.assertFalse(output.exists())

    def test_canonical_container_address_is_embedded_with_portable_line_endings(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "settings.php"
            subprocess.run(
                [sys.executable, str(GENERATOR), "172.30.0.2", "--output", str(output)],
                check=True, capture_output=True,
            )
            content = output.read_bytes()
            self.assertIn(b"=== '172.30.0.2'", content)
            self.assertNotIn(b"@COLLABORA_IP@", content)
            self.assertNotIn(b"\r", content)


if __name__ == "__main__":
    unittest.main()

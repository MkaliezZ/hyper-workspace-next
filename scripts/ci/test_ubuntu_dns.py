"""No network or host-file mutations: validate the privileged CI input boundary."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("ubuntu_dns", Path(__file__).with_name("ubuntu-dns.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def response(ip="8.8.8.8"):
    return {"Status": 0, "Question": [{"name": "archive.ubuntu.com.", "type": 1}],
            "Answer": [{"type": 1, "data": ip}]}


class UbuntuDnsTest(unittest.TestCase):
    def test_public_answers_are_deduplicated(self):
        value = response()
        value["Answer"] *= 2
        self.assertEqual(module.addresses(value), ["8.8.8.8"])

    def test_nonpublic_and_injected_addresses_are_rejected(self):
        for value in ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.0.2.1", "::1", "8.8.8.8\nprivate.invalid"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                module.addresses(response(value))

    def test_wrong_question_error_and_partial_responses_are_rejected(self):
        for key, value in [("Question", []), ("Status", 2), ("CD", True), ("TC", True), ("Answer", [])]:
            changed = response()
            changed[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                module.addresses(changed)

    def test_answer_count_is_bounded(self):
        value = response()
        value["Answer"] *= 33
        with self.assertRaises(ValueError):
            module.addresses(value)

    def test_host_mutation_is_not_available_outside_ci(self):
        with patch.object(module.sys, "argv", ["ubuntu-dns.py"]), patch.dict(module.os.environ, {"GITHUB_ACTIONS": "false"}):
            with self.assertRaises(ValueError):
                module.main()


if __name__ == "__main__":
    unittest.main()

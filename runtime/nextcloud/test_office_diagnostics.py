"""Failure diagnostics must remain safe even when upstream logs contain tokens."""
import importlib.util
import json
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location(
    "office_diagnostics",
    Path(__file__).resolve().parents[2] / "scripts/ci/office-diagnostics.py",
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class OfficeDiagnosticsTest(unittest.TestCase):
    def test_private_urls_and_error_details_never_leave_the_classifier(self):
        secret = "fixture-access-token-never-publish"
        result = module.summarize([
            f"ERR WOPI CheckFileInfo failed https://source/wopi?access_token={secret}\n",
            f"ERR Operation not permitted: coolmount /private/{secret}\n",
            f"unexpected upstream output {secret}\n",
        ])
        self.assertNotIn(secret, json.dumps(result))
        self.assertEqual(result["lines"], 3)
        self.assertEqual(result["categories"]["sandbox_or_permission"], 1)
        self.assertEqual(result["categories"]["wopi_failure"], 1)
        self.assertEqual(result["categories"]["error_severity"], 2)

    def test_empty_or_unrecognized_logs_do_not_invent_a_cause(self):
        self.assertEqual(module.summarize([]), {"lines": 0, "categories": {}})
        self.assertEqual(module.summarize(["ready\n"]), {"lines": 1, "categories": {}})


if __name__ == "__main__":
    unittest.main()

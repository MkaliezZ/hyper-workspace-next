#!/usr/bin/env python3
"""Classify disposable CODE logs without publishing log text or credentials."""
import json
import re
import sys
from collections import Counter


PATTERNS = {
    "sandbox_or_permission": r"permission denied|operation not permitted|seccomp|coolmount|failed to (?:mount|unshare)|chroot.*fail",
    "kit_exit_or_crash": r"segmentation fault|signal (?:6|11)|kit.*(?:died|crash|exited|terminated)|child.*(?:died|crash|exited abnormally)",
    "wopi_failure": r"(?:wopi|checkfileinfo|getfile).*(?:fail|error|unauthorized|forbidden|timeout)",
    "document_load_failure": r"faileddocloading|document.*(?:load.*fail|fail.*load)|failed to load|load.*timeout",
    "websocket_failure": r"websocket.*(?:error|fail|closed|disconnect)|socket.*(?:broken pipe|connection reset)",
    "storage_failure": r"storage.*(?:error|fail|timeout)|disk.*full|no space left",
    "error_severity": r"\b(?:ERR|FTL|FATAL)\b",
}


def summarize(lines):
    counts = Counter()
    total = 0
    for line in lines:
        total += 1
        for category, pattern in PATTERNS.items():
            if re.search(pattern, line, re.IGNORECASE):
                counts[category] += 1
    return {"lines": total, "categories": dict(sorted(counts.items()))}


if __name__ == "__main__":
    # No log line, URL, exception message or matched substring is returned.
    print(json.dumps({"office_log_summary": summarize(sys.stdin)}))

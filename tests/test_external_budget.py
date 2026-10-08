import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from review_desk.external_budget import reserve


class ExternalBudgetTest(unittest.TestCase):
    def test_budget_persists_and_counts_uncertain_attempts(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'attempts.json'
            with patch.dict('os.environ',{'REVIEW_POLISH_BUDGET_FILE':str(path),'REVIEW_POLISH_MAX_ATTEMPTS':'2'}):
                reserve();reserve()
                with self.assertRaisesRegex(RuntimeError,'累计调用上限'):reserve()
                self.assertEqual(json.loads(path.read_text()),{'attempts':2})

    def test_experience_without_authorized_limit_fails_closed(self):
        with patch.dict('os.environ',{'REVIEW_ENVIRONMENT':'experience','REVIEW_POLISH_BUDGET_FILE':''}):
            with self.assertRaisesRegex(RuntimeError,'上限尚未配置'):reserve()

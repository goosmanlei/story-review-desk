import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from review_desk.external_budget import reserve
from concurrent.futures import ThreadPoolExecutor


class ExternalBudgetTest(unittest.TestCase):
    def test_daily_limit_survives_reopening_and_rolls_over_only_on_next_day(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'attempts.json'
            with patch.dict('os.environ',{'REVIEW_POLISH_BUDGET_FILE':str(path),'REVIEW_POLISH_DAILY_LIMIT':'2','REVIEW_POLISH_MAX_ATTEMPTS':'0'}):
                with patch('review_desk.external_budget.day',return_value='2026-10-09'):
                    reserve();reserve()
                    with self.assertRaisesRegex(RuntimeError,'今日调用上限'):reserve()
                with patch('review_desk.external_budget.day',return_value='2026-10-10'):reserve()
                self.assertEqual(json.loads(path.read_text()),{'date':'2026-10-10','attempts':1,'total_attempts':3})

    def test_parallel_calls_cannot_exceed_the_daily_limit(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'attempts.json'
            def attempt(_):
                try:reserve();return True
                except RuntimeError:return False
            with patch.dict('os.environ',{'REVIEW_POLISH_BUDGET_FILE':str(path),'REVIEW_POLISH_DAILY_LIMIT':'2','REVIEW_POLISH_MAX_ATTEMPTS':'0'}):
                with ThreadPoolExecutor(max_workers=4) as pool:self.assertEqual(sum(pool.map(attempt,range(4))),2)
                self.assertEqual(json.loads(path.read_text())['attempts'],2)

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

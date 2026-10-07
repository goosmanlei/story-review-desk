"""Comment reads may share SOURCE parsing, never exact anchors or originals."""
import copy
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.request

import test_production as production_fixtures
from review_desk import production_media
from review_desk.server import ReviewServer
from review_desk.store import Store, digest


def document(source_id="source", text="甲乙𪎊丁"):
    return {
        "id": source_id, "title": "Technical comment fixture", "version_type": "original",
        "origin": "test", "source_url": "https://example.org/test", "collected_at": "2026-10-05",
        "notes": "Technical test only", "assets": [], "group": "story-refinements", "order": 1,
        "blocks": [{"id": "body", "text": text}],
    }


def source_row(store, source_id="source", comment_id="row", quote="甲乙"):
    revision = next(o["current_revision"] for o in store.objects() if o["id"] == source_id)
    return {
        "id": comment_id, "source_id": source_id, "target_object_id": source_id,
        "target_revision_id": revision, "body": "核对准确原文", "status": "OPEN", "version": 1,
        "anchor": {"block_id": "body", "end_block_id": "body", "start": 0,
                   "end": len(quote), "quote": quote},
    }


class CommentSourceReuseTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = Store(self.root / ".runtime/review.sqlite3")
        self.addCleanup(self.store.close)
        self.source_digest = self.store.put_source(document())

    def test_batch_matches_single_anchor_validation_without_caching_targets(self):
        self.store.put_source(document("other", "天地玄黄"))
        for row in (source_row(self.store, comment_id="first"),
                    source_row(self.store, comment_id="second", quote="甲乙𪎊"),
                    source_row(self.store, "other", "third", "天地")):
            self.store.create_comment(row)
        rows = self.store.comments()
        before = copy.deepcopy(rows)
        expected = [{**row, "anchor_state": self.store.anchor_state(
            row["target_object_id"], row["target_revision_id"], row["anchor"])} for row in rows]
        statements = []
        self.store.db.set_trace_callback(statements.append)
        try:
            with patch.object(self.store, "source", wraps=self.store.source) as read_source, \
                    patch("review_desk.store.digest", wraps=digest) as source_digest:
                actual = self.store.comment_anchor_states(rows)
                self.assertEqual(read_source.call_count, 2)
                self.assertEqual(source_digest.call_count, 2)
        finally:
            self.store.db.set_trace_callback(None)
        self.assertEqual(actual, expected)
        self.assertEqual(rows, before)
        self.assertEqual(sum(sql.startswith("SELECT * FROM objects WHERE id=") for sql in statements), 3)
        self.assertEqual(sum(sql.startswith("SELECT * FROM revisions WHERE id=") for sql in statements), 3)
        self.assertEqual(self.store.comments(), before)

    def test_bad_anchor_or_revision_does_not_poison_another_comment(self):
        good = source_row(self.store)
        self.store.put_source(document("other", "天地玄黄"))
        other = source_row(self.store, "other", quote="天地")
        rows = [good,
                {**good, "anchor": {**good["anchor"], "quote": "错引"}},
                {**good, "anchor": {**good["anchor"], "block_id": "missing"}},
                {**good, "anchor": {"type": "global"}},
                {**good, "target_revision_id": other["target_revision_id"]},
                {**good, "target_revision_id": "missing"}, good]
        original = copy.deepcopy(rows)
        result = self.store.comment_anchor_states(rows)
        self.assertEqual([row["anchor_state"]["valid"] for row in result],
                         [True, False, False, False, False, False, True])
        for row, item in zip(rows, result):
            self.assertEqual(item["anchor_state"], self.store.anchor_state(
                row["target_object_id"], row["target_revision_id"], row["anchor"]))
        self.assertEqual(rows, original)

    def test_next_read_and_comment_write_see_legitimate_source_replacement(self):
        # No stored comments: the established replacement API permits this change.
        old = source_row(self.store)
        self.assertTrue(self.store.comment_anchor_states([old])[0]["anchor_state"]["valid"])
        self.store.replace_source_content(document(text="天地玄黄"), self.source_digest)
        new = source_row(self.store, comment_id="after-replacement", quote="天地")
        self.assertNotEqual(old["target_revision_id"], new["target_revision_id"])
        result = self.store.comment_anchor_states([new, old, new])
        self.assertEqual([row["anchor_state"]["valid"] for row in result], [True, False, True])
        saved = self.store.create_comment(new)
        self.assertEqual(saved["target_revision_id"], new["target_revision_id"])
        self.assertEqual(saved["anchor"]["quote"], "天地")

    def test_historical_non_source_revision_stays_exact_in_a_mixed_batch(self):
        first = self.store.put_object("story", "STORY", {"body": "旧稿正文"})
        second = self.store.put_object("story", "STORY", {"body": "新稿正文"}, 1)
        historical = {**source_row(self.store), "source_id": None, "target_object_id": "story",
                      "target_revision_id": first["revision"],
                      "anchor": {"block_id": "body", "end_block_id": "body",
                                 "start": 0, "end": 2, "quote": "旧稿"}}
        rows = [source_row(self.store), historical,
                {**historical, "target_revision_id": second["revision"]}, historical]
        result = self.store.comment_anchor_states(rows)
        self.assertEqual([row["anchor_state"]["valid"] for row in result], [True, True, False, True])
        self.assertEqual(result[1]["target_revision_id"], first["revision"])

    def test_unexpected_batch_failure_leaves_no_cache_for_next_request(self):
        old = source_row(self.store)

        def broken_rows():
            yield old
            raise RuntimeError("injected response assembly failure")

        with self.assertRaisesRegex(RuntimeError, "injected response assembly"):
            self.store.comment_anchor_states(broken_rows())
        self.store.replace_source_content(document(text="天地玄黄"), self.source_digest)
        new = source_row(self.store, quote="天地")
        with patch.object(self.store, "source", wraps=self.store.source) as read_source:
            result = self.store.comment_anchor_states([new, new])
        self.assertEqual(read_source.call_count, 1)
        self.assertTrue(all(row["anchor_state"]["valid"] for row in result))

    def test_media_is_validated_again_for_each_anchor_and_after_file_changes(self):
        fixture = production_fixtures.ProductionTest()
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        component = fixture.media()
        target = fixture.ref("voice")
        row = {"target_object_id": target["object_id"], "target_revision_id": target["revision_id"],
               "body": "Technical time anchor", "anchor": {"type": "time", "component_id": "original",
               "asset_file": component["file"], "start_seconds": 0.1, "end_seconds": 0.3}}
        first = fixture.store.create_comment({**row, "id": "time-one"})
        second = fixture.store.create_comment({**row, "id": "time-two"})
        asset = fixture.root / "export/assets" / component["file"]
        original = asset.read_bytes()
        validate_original = production_media.validate_component
        calls = []

        def validate_then_damage(*args, **kwargs):
            calls.append(args[1]["file"])
            value = validate_original(*args, **kwargs)
            if len(calls) == 1:
                # Same size, different hash: merely checking existence/size must fail.
                asset.write_bytes(bytes([original[0] ^ 1]) + original[1:])
            return value

        with patch.object(production_media, "validate_component", side_effect=validate_then_damage):
            result = fixture.store.comment_anchor_states([first, second])
        self.assertEqual(calls, [component["file"], component["file"]])
        self.assertEqual([item["anchor_state"]["valid"] for item in result], [True, False])
        self.assertIn("checksum", result[1]["anchor_state"]["reason"])
        asset.write_bytes(original)
        self.assertTrue(all(item["anchor_state"]["valid"]
                            for item in fixture.store.comment_anchor_states([first, second])))
        asset.unlink()
        self.assertFalse(any(item["anchor_state"]["valid"]
                             for item in fixture.store.comment_anchor_states([first, second])))

    def test_overlapping_reads_do_not_share_same_named_source_between_instances(self):
        barrier = threading.Barrier(2)

        def read_instance(index, text):
            store = Store(self.root / ("concurrent-" + str(index)) / ".runtime/review.sqlite3")
            try:
                store.put_source(document(text=text))
                row = source_row(store, quote=text[:2])

                def overlapping_rows():
                    yield row
                    barrier.wait(timeout=3)
                    yield row

                return store.comment_anchor_states(overlapping_rows())
            finally:
                store.close()

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(read_instance, index, text)
                       for index, text in enumerate(("甲乙𪎊丁", "天地玄黄"))]
            results = [future.result(timeout=5) for future in futures]
        self.assertTrue(all(row["anchor_state"]["valid"] for rows in results for row in rows))
        self.assertEqual([rows[1]["anchor"]["quote"] for rows in results], ["甲乙", "天地"])

    def test_http_filters_keep_complete_rows_and_use_a_fresh_batch(self):
        with ReviewServer(("127.0.0.1", 0), self.root / "http", {"id": "fixture", "title": "fixture"}) as server:
            for source_id in ("source", "other"):
                server.store.put_source(document(source_id))
            for source_id, comment_id in (("source", "one"), ("source", "two"), ("other", "three")):
                server.store.create_comment(source_row(server.store, source_id, comment_id))
            revision = source_row(server.store)["target_revision_id"]
            suffixes = ["", "?source_id=source",
                        "?target_object_id=source&target_revision_id=" + revision, "?source_id=absent"]
            before = (server.store.comments(), server.store.events(), server.store.revisions())
            results, errors = [], []

            def request_rows():
                try:
                    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                    for suffix in suffixes:
                        with opener.open("http://127.0.0.1:" + str(server.server_port) +
                                         "/api/comments" + suffix, timeout=3) as response:
                            results.append(json.load(response))
                except Exception as exc:
                    errors.append(exc)

            # Each bounded HTTP worker owns its connection; observe the reader
            # across those instances, not only the fixture's owner connection.
            with patch.object(Store, "comment_anchor_states", autospec=True, side_effect=Store.comment_anchor_states) as batch:
                client = threading.Thread(target=request_rows, daemon=True)
                client.start()
                server.timeout = 3
                for _ in suffixes:
                    server.handle_request()
                client.join(timeout=3)
                self.assertFalse(client.is_alive())
                self.assertEqual(errors, [])
                self.assertEqual(batch.call_count, 4)
            self.assertEqual([len(rows) for rows in results], [3, 2, 2, 0])
            self.assertEqual(results[1], results[2])
            self.assertTrue(all(row["anchor_state"]["valid"] for rows in results for row in rows))
            self.assertEqual([{k: v for k, v in row.items() if k not in ("anchor_state","business_code")} for row in results[0]], before[0])
            self.assertEqual((server.store.comments(), server.store.events(), server.store.revisions()), before)


if __name__ == "__main__":
    unittest.main()

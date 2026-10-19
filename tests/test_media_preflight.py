"""Physical integrity preflight cannot silently rescan or reuse changed bytes."""
import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from review_desk.production_media import physical_file_hash,physical_hash_scope,frozen_physical_hashes


class MediaPreflightTest(unittest.TestCase):
    def test_frozen_scope_reuses_bytes_but_rejects_replacement_and_unprepared_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'original';path.write_bytes(b'original')
            expected=hashlib.sha256(b'original').hexdigest()
            with physical_hash_scope():
                self.assertEqual(physical_file_hash(path),expected)
                with patch.object(Path,'open',side_effect=AssertionError('media opened inside transaction')):
                    with frozen_physical_hashes():self.assertEqual(physical_file_hash(path),expected)
                other=Path(directory)/'new';other.write_bytes(b'new')
                with self.assertRaisesRegex(ValueError,'not preflighted'):
                    with frozen_physical_hashes():physical_file_hash(other)
                # Same size and mtime cannot disguise an inode replacement.
                stamp=path.stat();replacement=Path(directory)/'replacement';replacement.write_bytes(b'changed!')
                os.utime(replacement,ns=(stamp.st_atime_ns,stamp.st_mtime_ns));replacement.replace(path)
                with self.assertRaisesRegex(ValueError,'media changed'):
                    with frozen_physical_hashes():physical_file_hash(path)
            with physical_hash_scope():
                self.assertEqual(physical_file_hash(path),hashlib.sha256(b'changed!').hexdigest())

    def test_scope_exit_detects_change_even_if_validation_already_read_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'original';path.write_bytes(b'first')
            with physical_hash_scope():
                physical_file_hash(path)
                with self.assertRaisesRegex(ValueError,'media changed'):
                    with frozen_physical_hashes():
                        physical_file_hash(path)
                        path.write_bytes(b'other')


if __name__=='__main__':unittest.main()

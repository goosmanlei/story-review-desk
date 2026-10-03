import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from review_desk.bundle import export, restore
from review_desk.store import Store, digest


class BundleIntegrityTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = Store(self.root / 'source/.runtime/review.sqlite3')
        self.destination = Store(self.root / 'destination/.runtime/review.sqlite3')
        self.bundle = self.root / 'source/export'
        self.source.put_source({
            'id': 'source', 'title': 'Source', 'version_type': 'original', 'origin': 'fixture',
            'source_url': 'https://example.org/source', 'collected_at': '2026-10-04',
            'notes': 'fixture', 'assets': [], 'blocks': [{'id': 'body', 'text': 'Original text'}],
        })
        self.source.create_comment({'id': 'comment', 'source_id': 'source',
                                    'anchor': {'block_id': 'body', 'end_block_id': 'body',
                                               'start': 0, 'end': 8, 'quote': 'Original'},
                                    'body': 'Original opinion'})

    def tearDown(self):
        self.destination.close()
        self.source.close()
        self.temp.cleanup()

    def contents(self):
        return {path.name: path.read_bytes() for path in self.bundle.iterdir() if path.is_file()}

    def assert_empty(self, store=None):
        store = store or self.destination
        tables = [row[0] for row in store.db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        for name in tables:
            self.assertEqual(store.db.execute('SELECT COUNT(*) FROM ' + name).fetchone()[0], 0, name)

    def assert_no_stage(self, directory):
        self.assertEqual(list(directory.glob('.bundle-*')), [])

    def layout(self):
        config = self.root / 'source/config'
        config.mkdir()
        path = config / 'entity-relationship-layout.json'
        path.write_text(json.dumps({'format': 'entity-relationship-layout-v1', 'entities': {}}))
        return path

    def test_restore_rejects_core_file_missing_from_manifest(self):
        manifest = export(self.source, self.bundle)
        del manifest['files']['comments.json']
        (self.bundle / 'manifest.json').write_text(json.dumps(manifest))
        comments = json.loads((self.bundle / 'comments.json').read_text())
        comments['comments'][0]['body'] = 'Changed without a checksum'
        (self.bundle / 'comments.json').write_text(json.dumps(comments))
        with self.assertRaisesRegex(ValueError, 'manifest|missing'):
            restore(self.destination, self.bundle)
        self.assert_empty()

    def test_restore_layout_failure_keeps_database_empty_and_retryable(self):
        self.layout()
        export(self.source, self.bundle)
        config = self.root / 'destination/config'
        config.write_text('An existing file blocks the directory')
        with self.assertRaises(OSError):
            restore(self.destination, self.bundle)
        self.assert_empty()
        config.unlink()
        restore(self.destination, self.bundle)
        self.assertEqual(self.destination.comments(), self.source.comments())

    def test_failed_export_preserves_last_complete_bundle(self):
        layout = self.layout()
        export(self.source, self.bundle)
        previous = self.contents()
        self.source.change_comment('comment', 'EDIT', 1, 'A newer opinion')
        layout.write_text('{invalid JSON')
        with self.assertRaises(ValueError):
            export(self.source, self.bundle)
        self.assertEqual(self.contents(), previous)
        restore(self.destination, self.bundle)
        self.assertEqual(self.destination.comments()[0]['body'], 'Original opinion')

    def test_all_supported_schemas_require_their_core_files_and_still_restore(self):
        for schema in (1, 2, 3, 4):
            manifest = export(self.source, self.bundle)
            manifest['schema_version'] = schema
            if schema == 1:
                for name in ('objects.json', 'configurations.json'):
                    del manifest['files'][name]
            elif schema < 4:
                objects = json.loads((self.bundle / 'objects.json').read_text())
                for name in list(objects):
                    if name.startswith('material_'):
                        del objects[name]
                data = json.dumps(objects).encode()
                (self.bundle / 'objects.json').write_bytes(data)
                manifest['files']['objects.json'] = digest(data)
            required = ('materials.json', 'comments.json') if schema == 1 else ('materials.json', 'comments.json', 'objects.json', 'configurations.json')
            for missing in required:
                with self.subTest(schema=schema, missing=missing):
                    incomplete = {**manifest, 'files': {k: v for k, v in manifest['files'].items() if k != missing}}
                    (self.bundle / 'manifest.json').write_text(json.dumps(incomplete))
                    with self.assertRaisesRegex(ValueError, 'manifest|missing'):
                        restore(self.destination, self.bundle)
                    self.assert_empty()
            with self.subTest(schema=schema, complete=True):
                (self.bundle / 'manifest.json').write_text(json.dumps(manifest))
                recovered = Store(self.root / str(schema) / '.runtime/review.sqlite3')
                try:
                    restore(recovered, self.bundle)
                    self.assertEqual(recovered.sources(), self.source.sources())
                    self.assertEqual(recovered.comments(), self.source.comments())
                    self.assertEqual(recovered.events(), self.source.events())
                finally:
                    recovered.close()

    def test_export_staging_failure_does_not_replace_previous_files(self):
        export(self.source, self.bundle)
        previous = self.contents()
        self.source.change_comment('comment', 'EDIT', 1, 'A newer opinion')
        write = Path.write_bytes

        def fail_write(path, data):
            if path.parent.name == 'new' and path.name == 'comments.json':
                raise OSError('injected staging write failure')
            return write(path, data)

        with patch.object(Path, 'write_bytes', fail_write):
            with self.assertRaisesRegex(OSError, 'staging'):
                export(self.source, self.bundle)
        self.assertEqual(self.contents(), previous)
        self.assert_no_stage(self.bundle)

    def test_export_replacement_failure_restores_previous_bundle_and_can_retry(self):
        self.layout()
        export(self.source, self.bundle)
        previous = self.contents()
        self.source.change_comment('comment', 'EDIT', 1, 'A newer opinion')
        replace = Path.replace
        for failure_name in ('comments.json', 'manifest.json'):
            with self.subTest(failure_name=failure_name):
                def fail_replace(path, destination):
                    if path.parent.name == 'new' and path.name == failure_name:
                        raise OSError('injected replacement failure')
                    return replace(path, destination)

                with patch.object(Path, 'replace', fail_replace):
                    with self.assertRaisesRegex(OSError, 'replacement'):
                        export(self.source, self.bundle)
                self.assertEqual(self.contents(), previous)
                self.assert_no_stage(self.bundle)
        restore(self.destination, self.bundle)
        self.assertEqual(self.destination.comments()[0]['body'], 'Original opinion')
        export(self.source, self.bundle)
        self.assertEqual(json.loads((self.bundle / 'comments.json').read_text())['comments'][0]['body'], 'A newer opinion')

    def test_first_export_replacement_failure_removes_partial_metadata(self):
        replace = Path.replace

        def fail_manifest(path, destination):
            if path.parent.name == 'new' and path.name == 'manifest.json':
                raise OSError('injected manifest failure')
            return replace(path, destination)

        with patch.object(Path, 'replace', fail_manifest):
            with self.assertRaisesRegex(OSError, 'manifest'):
                export(self.source, self.bundle)
        self.assertEqual(self.contents(), {})
        self.assert_no_stage(self.bundle)

    def test_export_retains_recovery_files_if_rollback_also_fails(self):
        export(self.source, self.bundle)
        previous = self.contents()
        self.source.set_configuration('PROJECT', {'story_background': 'New background'}, 0)
        replace = Path.replace

        def fail_replace(path, destination):
            if path.parent.name == 'new' and path.name == 'manifest.json':
                raise OSError('injected publication failure')
            if path.parent.name == 'previous' and path.name == 'configurations.json':
                raise OSError('injected rollback failure')
            return replace(path, destination)

        with patch.object(Path, 'replace', fail_replace):
            with self.assertRaisesRegex(RuntimeError, 'recovery metadata retained') as error:
                export(self.source, self.bundle)
        stages = list(self.bundle.glob('.bundle-*'))
        self.assertEqual(len(stages), 1)
        self.assertIn(str(stages[0]), str(error.exception))
        self.assertEqual((stages[0] / 'previous/configurations.json').read_bytes(), previous['configurations.json'])
        self.assertEqual((self.bundle / 'manifest.json').read_bytes(), previous['manifest.json'])

    def test_restore_layout_replacement_failure_rolls_back_every_table(self):
        self.layout()
        export(self.source, self.bundle)
        config = self.root / 'destination/config'
        config.mkdir()
        old_layout = config / 'entity-relationship-layout.json'
        old_layout.write_bytes(b'original destination layout')
        replace = Path.replace

        def fail_layout(path, destination):
            if path.parent.name == 'new' and path.name == old_layout.name:
                raise OSError('injected layout replacement failure')
            return replace(path, destination)

        with patch.object(Path, 'replace', fail_layout):
            with self.assertRaisesRegex(OSError, 'layout replacement'):
                restore(self.destination, self.bundle)
        self.assert_empty()
        self.assertEqual(old_layout.read_bytes(), b'original destination layout')
        self.assert_no_stage(config)
        restore(self.destination, self.bundle)
        self.assertEqual(self.destination.comments(), self.source.comments())

    def test_restore_database_commit_failure_restores_layout_and_remains_retryable(self):
        self.layout()
        export(self.source, self.bundle)
        config = self.root / 'destination/config'
        config.mkdir()
        layout = config / 'entity-relationship-layout.json'
        layout.write_bytes(b'previous layout')
        reader = sqlite3.connect(str(self.destination.db_path))
        try:
            reader.execute('BEGIN')
            reader.execute('SELECT * FROM sources').fetchall()
            self.destination.db.execute('PRAGMA busy_timeout=1')
            with self.assertRaisesRegex(sqlite3.OperationalError, 'locked'):
                restore(self.destination, self.bundle)
        finally:
            reader.rollback()
            reader.close()
        self.assert_empty()
        self.assertEqual(layout.read_bytes(), b'previous layout')
        self.assert_no_stage(config)
        restore(self.destination, self.bundle)
        self.assertEqual(self.destination.events(), self.source.events())

    def test_export_rejects_symlink_metadata_without_touching_its_target(self):
        export(self.source, self.bundle)
        outside = self.root / 'outside.json'
        outside.write_bytes(b'outside file')
        (self.bundle / 'comments.json').unlink()
        (self.bundle / 'comments.json').symlink_to(outside)
        with self.assertRaisesRegex(ValueError, 'regular file'):
            export(self.source, self.bundle)
        self.assertEqual(outside.read_bytes(), b'outside file')
        self.assertTrue((self.bundle / 'comments.json').is_symlink())
        self.assert_no_stage(self.bundle)


if __name__ == '__main__':
    unittest.main()

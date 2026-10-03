import base64
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from review_desk import favicon


SVG = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M1 1h2v2H1Z"/></svg>'


class FaviconLimitsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.assets = self.root / 'export/assets'
        self.assets.mkdir(parents=True)

    def tearDown(self):
        self.temp.cleanup()

    def test_oversized_regular_file_is_rejected_without_reading_content(self):
        path = self.assets / 'large.png'
        path.write_bytes(b'x' * (favicon.MAX_BYTES + 1))
        original_open = Path.open

        def no_content_read(candidate, *args, **kwargs):
            self.assertNotEqual(candidate, path, 'oversized content must not be opened')
            return original_open(candidate, *args, **kwargs)

        with patch.object(Path, 'open', no_content_read):
            with self.assertRaisesRegex(ValueError, '256 KiB'):
                favicon.asset(self.root, path.name)
            self.assertEqual(favicon.choices(self.root), [])

    def tracked_open(self, path, reads, before_open=None):
        original_open = Path.open
        case = self

        class Reader:
            def __init__(self, stream):
                self.stream = stream

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return self.stream.__exit__(*args)

            def read(self, size=-1):
                case.assertEqual(size, favicon.MAX_BYTES + 1, 'managed icon reads must stay bounded')
                data = self.stream.read(size)
                reads.append({'requested': size, 'returned': len(data)})
                return data

        def open_file(candidate, mode='r', *args, **kwargs):
            if candidate == path and mode == 'rb':
                if before_open:
                    before_open(original_open)
                return Reader(original_open(candidate, mode, *args, **kwargs))
            return original_open(candidate, mode, *args, **kwargs)

        return open_file

    def test_exact_size_limit_accepts_valid_content_with_a_bounded_read(self):
        path = self.assets / 'existing-name.svg'
        data = SVG + b' ' * (favicon.MAX_BYTES - len(SVG))
        path.write_bytes(data)
        reads = []
        with patch.object(Path, 'open', self.tracked_open(path, reads)):
            self.assertEqual(favicon.asset(self.root, path.name), (path, data))
        self.assertEqual(reads, [{'requested': favicon.MAX_BYTES + 1, 'returned': favicon.MAX_BYTES}])

    def test_file_growth_after_size_check_is_bounded_and_rejected(self):
        path = self.assets / 'growing.svg'
        path.write_bytes(SVG)
        reads = []

        def grow(original_open):
            with original_open(path, 'ab') as stream:
                stream.write(b' ' * favicon.MAX_BYTES)

        with patch.object(Path, 'open', self.tracked_open(path, reads, grow)):
            with self.assertRaisesRegex(ValueError, '256 KiB'):
                favicon.asset(self.root, path.name)
        self.assertEqual(reads, [{'requested': favicon.MAX_BYTES + 1, 'returned': favicon.MAX_BYTES + 1}])

    def test_content_changed_after_size_check_still_requires_image_validation(self):
        path = self.assets / 'changed.svg'
        path.write_bytes(SVG)
        reads = []

        def corrupt(original_open):
            with original_open(path, 'wb') as stream:
                stream.write(b'not an image')

        with patch.object(Path, 'open', self.tracked_open(path, reads, corrupt)):
            with self.assertRaises(ValueError):
                favicon.asset(self.root, path.name)
        self.assertEqual(reads[0]['returned'], len(b'not an image'))

    def test_disappearing_file_does_not_break_other_choices(self):
        path = self.assets / 'disappearing.svg'
        path.write_bytes(SVG)
        (self.assets / 'kept.svg').write_bytes(SVG)

        def disappear(original_open):
            path.unlink()

        with patch.object(Path, 'open', self.tracked_open(path, [], disappear)):
            self.assertEqual(favicon.choices(self.root), ['kept.svg'])

    def test_valid_existing_names_upload_and_invalid_paths_keep_their_semantics(self):
        (self.assets / 'custom-name.svg').write_bytes(SVG)
        uploaded = favicon.upload(self.root, 'icon.svg', base64.b64encode(SVG).decode())
        self.assertEqual(favicon.upload(self.root, 'icon.svg', base64.b64encode(SVG).decode()), uploaded)
        self.assertEqual(favicon.asset(self.root, uploaded)[1], SVG)
        (self.assets / 'link.svg').symlink_to(self.assets / 'custom-name.svg')
        (self.assets / 'directory.svg').mkdir()
        (self.assets / 'script.svg').write_bytes(SVG.replace(b'<path d="M1 1h2v2H1Z"/>', b'<script>x</script>'))
        (self.assets / 'empty.svg').write_bytes(b'')
        (self.assets / 'wrong.txt').write_bytes(SVG)
        for name in ('missing.svg', 'link.svg', 'directory.svg', '../custom-name.svg', 'https://example.org/icon.svg', 'script.svg', 'empty.svg', 'wrong.txt'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                favicon.asset(self.root, name)
        self.assertEqual(favicon.choices(self.root), sorted(['custom-name.svg', uploaded]))


if __name__ == '__main__':
    unittest.main()

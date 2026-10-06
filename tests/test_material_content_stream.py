import json
from pathlib import Path
import tempfile
import unittest
from review_desk.material_content_stream import rows


class ContentStreamTest(unittest.TestCase):
    def test_chunk_boundaries_unicode_and_layout(self):
        content=[{'id':'a','body':json.dumps({'value':'转\\\"\n😀'*18000},ensure_ascii=False)},
                 {'id':'b','body':'{"value":false}'}]
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'content.json'
            for indent in (None,2):
                for reverse in (False,True):
                    envelope={'format':'material-content-v1','material_content':content}
                    if reverse:envelope=dict(reversed(list(envelope.items())))
                    path.write_text(json.dumps(envelope,ensure_ascii=False,indent=indent),encoding='utf-8')
                    self.assertEqual(list(rows(path)),content)

    def test_truncation_extra_data_and_invalid_envelope(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'content.json'
            valid='{"format":"material-content-v1","material_content":[]}'
            for value in (valid[:-1],valid+'{}',valid.replace('[]','[{},]'),valid.replace('material-content-v1','wrong'),valid.replace('[]','[{"id":1,"body":"a"}]')):
                path.write_text(value)
                with self.assertRaises(ValueError):list(rows(path))

"""Small, content-addressed static bundles without a build service."""
import gzip
import hashlib
from pathlib import Path
import re


class WebAssets:
    def __init__(self):
        root = Path(__file__).parent / 'static'
        page = (root/'index.html').read_text()
        self.files = {}
        for pattern, extension, mime in (
            (r'<link rel="stylesheet" href="/([\w-]+\.css)">', 'css', 'text/css'),
            (r'<script src="/([\w-]+\.js)" defer></script>', 'js', 'text/javascript'),
        ):
            matches = list(re.finditer(pattern, page))
            parts = [(root/match.group(1)).read_bytes() for match in matches]
            body = (b'\n;\n' if extension == 'js' else b'\n').join(parts)
            fingerprint = hashlib.sha256(body).hexdigest()
            url = f'/static/{fingerprint}/desk.{extension}'
            self.files[url] = (body, gzip.compress(body, compresslevel=6, mtime=0), mime)
            tag = f'<script src="{url}" defer></script>' if extension == 'js' else f'<link rel="stylesheet" href="{url}">'
            page = re.sub(pattern, '', page[:matches[0].start()])+tag+re.sub(pattern, '', page[matches[0].end():])
        self.index = page.encode()

    def serve(self, handler, path):
        entry = self.files.get(path)
        if entry is None:
            return False
        _, compressed = handler._representation()
        data = entry[1] if compressed else entry[0]
        etag = '"'+hashlib.sha256(data).hexdigest()+'"'
        unchanged = handler.headers.get('If-None-Match') == etag
        handler.send_response(304 if unchanged else 200)
        handler.send_header('Content-Type', entry[2]+'; charset=utf-8')
        handler.send_header('Cache-Control', 'public, max-age=31536000, immutable')
        handler.send_header('ETag', etag)
        handler.send_header('Vary', 'Accept-Encoding')
        handler.send_header('X-Content-Type-Options', 'nosniff')
        if compressed:
            handler.send_header('Content-Encoding', 'gzip')
        if not unchanged:
            handler.send_header('Content-Length', str(len(data)))
        handler.end_headers()
        if not unchanged:
            handler.wfile.write(data)
        return True

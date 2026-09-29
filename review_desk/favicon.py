"""Small, local favicon intake; files live in the existing managed export assets."""
import base64
import hashlib
import re
import struct
import xml.etree.ElementTree as ET
import zlib
from pathlib import Path

MIMES = {'.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'}
MAX_BYTES = 256 * 1024


def validate_name(name):
    if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', name) or Path(name).suffix.lower() not in MIMES:
        raise ValueError('站点图标须引用受管的 SVG、PNG 或 ICO 文件名')
    return name


def validate_image(data, suffix):
    if not data or len(data) > MAX_BYTES:
        raise ValueError('站点图标文件须在 256 KiB 以内')
    try:
        if suffix == '.svg':
            if b'<!' in data or b'<?' in data:
                raise ValueError('SVG 不允许声明或外部内容')
            root = ET.fromstring(data)
            tags = {'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line', 'title', 'desc'}
            attrs = {'xmlns', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill-rule', 'opacity', 'transform', 'role', 'aria-label'}
            if root.tag != '{http://www.w3.org/2000/svg}svg' or not root.get('viewBox'):
                raise ValueError('SVG 须有命名空间与 viewBox')
            for element in root.iter():
                if element.tag not in {'{http://www.w3.org/2000/svg}' + tag for tag in tags}:
                    raise ValueError('SVG 仅支持静态基本形状')
                if any(key not in attrs or any(token in value.lower() for token in ('url(', 'javascript:', 'data:')) for key, value in element.attrib.items()):
                    raise ValueError('SVG 含不支持的属性或外部引用')
        elif suffix == '.png':
            if data[:8] != b'\x89PNG\r\n\x1a\n':
                raise ValueError('无效 PNG')
            offset, chunks, compressed = 8, [], b''
            while offset < len(data):
                size = struct.unpack('>I', data[offset:offset + 4])[0]
                kind = data[offset + 4:offset + 8]
                payload = data[offset + 8:offset + 8 + size]
                crc = struct.unpack('>I', data[offset + 8 + size:offset + 12 + size])[0]
                if len(payload) != size or zlib.crc32(kind + payload) != crc:
                    raise ValueError('PNG 校验失败')
                chunks.append(kind)
                if kind == b'IHDR':
                    width, height, depth, color, compression, filtering, interlace = struct.unpack('>IIBBBBB', payload)
                    if not (1 <= width <= 1024 and 1 <= height <= 1024 and depth == 8 and color in (2, 6) and compression == filtering == interlace == 0):
                        raise ValueError('PNG 须为至多 1024 像素的 8 位 RGB/RGBA 非交错图像')
                if kind == b'IDAT':
                    compressed += payload
                offset += size + 12
            if chunks[0] != b'IHDR' or chunks[-1] != b'IEND' or b'IDAT' not in chunks:
                raise ValueError('PNG 结构不完整')
            expected = height * (1 + width * (4 if color == 6 else 3))
            decoder = zlib.decompressobj()
            raw = decoder.decompress(compressed, expected + 1)
            if len(raw) != expected or not decoder.eof or decoder.unused_data or any(raw[row * (expected // height)] > 4 for row in range(height)):
                raise ValueError('PNG 像素数据无效')
        elif suffix == '.ico':
            reserved, kind, count = struct.unpack('<HHH', data[:6])
            if reserved or kind != 1 or not 1 <= count <= 16:
                raise ValueError('无效 ICO')
            for i in range(count):
                entry = data[6 + i * 16:22 + i * 16]
                w, h, colors, reserved, planes, bits, size, offset = struct.unpack('<BBBBHHII', entry)
                if reserved or offset < 6 + count * 16 or offset + size > len(data):
                    raise ValueError('ICO 图像范围无效')
                # PNG-encoded ICO avoids ambiguous bitmap headers and masks.
                payload = data[offset:offset + size]
                validate_image(payload, '.png')
                if struct.unpack('>II', payload[16:24]) != (w or 256, h or 256):
                    raise ValueError('ICO 尺寸不一致')
        else:
            raise ValueError('不支持的图标格式')
    except (ET.ParseError, struct.error, zlib.error, IndexError, UnboundLocalError) as exc:
        raise ValueError('无法解析站点图标文件') from exc
    return data


def asset(root, name):
    validate_name(name)
    base = (Path(root) / 'export' / 'assets').resolve()
    path = base / name
    if path.is_symlink() or not path.is_file() or path.resolve().parent != base:
        raise ValueError('站点图标文件不存在或不是受管本地文件')
    data = validate_image(path.read_bytes(), path.suffix.lower())
    return path, data


def upload(root, name, encoded):
    suffix = Path(validate_name(name)).suffix.lower()
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as exc:
        raise ValueError('无效图标上传内容') from exc
    validate_image(data, suffix)
    filename = 'favicon-' + hashlib.sha256(data).hexdigest() + suffix
    base = Path(root) / 'export' / 'assets'
    base.mkdir(parents=True, exist_ok=True)
    path = base / filename
    if path.is_symlink():
        raise ValueError('不允许图标符号链接')
    if path.exists() and path.read_bytes() != data:
        raise ValueError('图标文件校验冲突')
    path.write_bytes(data)
    return filename


def choices(root):
    result = []
    for path in sorted((Path(root) / 'export' / 'assets').glob('*')):
        if path.suffix.lower() not in MIMES:
            continue
        try:
            asset(root, path.name)
            result.append(path.name)
        except (ValueError, OSError):
            pass
    return result


def current(root, body):
    name = body.get('site_favicon', '')
    if name:
        path, data = asset(root, name)
    else:
        path = Path(__file__).parent / 'static' / 'favicon.svg'
        data = path.read_bytes()
    checksum = hashlib.sha256(data).hexdigest()
    return path, data, {'file': name, 'url': '/favicon.ico?v=' + checksum, 'mime': MIMES[path.suffix.lower()], 'sha256': checksum}

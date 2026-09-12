"""Pure original-image checks. No filesystem, API, or model access."""
import struct
import zlib

class ContextError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code

def image_dimensions(content: bytes, mime: str) -> tuple[int, int]:
    if mime == "image/png" and content.startswith(b"\x89PNG\r\n\x1a\n") and len(content) >= 24:
        offset = 8
        ended = False
        while offset + 12 <= len(content):
            size = int.from_bytes(content[offset:offset + 4], "big")
            if offset + 12 + size > len(content):
                raise ContextError("IMAGE_INVALID", "PNG数据块长度无效")
            kind_and_data = content[offset + 4:offset + 8 + size]
            if zlib.crc32(kind_and_data) != int.from_bytes(content[offset + 8 + size:offset + 12 + size], "big"):
                raise ContextError("IMAGE_INVALID", "PNG数据块完整性校验失败")
            offset += size + 12
            if kind_and_data[:4] == b"IEND":
                ended = offset == len(content)
                break
        if not ended:
            raise ContextError("IMAGE_INVALID", "PNG文件不完整")
        return struct.unpack(">II", content[16:24])
    if mime == "image/jpeg" and content.startswith(b"\xff\xd8"):
        index = 2
        while index + 4 <= len(content):
            if content[index] != 255:
                break
            while index < len(content) and content[index] == 255:
                index += 1
            if index >= len(content):
                break
            marker = content[index]
            index += 1
            if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
                continue
            if index + 2 > len(content):
                break
            length = int.from_bytes(content[index:index + 2], "big")
            if length < 2 or index + length > len(content):
                break
            if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF} and length >= 7:
                height, width = struct.unpack(">HH", content[index + 3:index + 7])
                return width, height
            index += length
    if mime == "image/webp" and len(content) >= 30 and content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        kind = content[12:16]
        if kind == b"VP8X":
            return (int.from_bytes(content[24:27], "little") + 1, int.from_bytes(content[27:30], "little") + 1)
        if kind == b"VP8 " and content[23:26] == b"\x9d\x01\x2a":
            return (int.from_bytes(content[26:28], "little") & 0x3FFF, int.from_bytes(content[28:30], "little") & 0x3FFF)
        if kind == b"VP8L" and content[20] == 0x2F:
            bits = int.from_bytes(content[21:25], "little")
            return ((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1)
    raise ContextError("IMAGE_INVALID", "图片格式、MIME或尺寸头无效")

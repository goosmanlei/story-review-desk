"""Content-addressed production files; no platform URLs stand in for originals."""
import hashlib
from contextlib import contextmanager
from contextvars import ContextVar
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile


NAME = re.compile(r"^[0-9a-f]{64}\.[a-z0-9]{1,12}$")
MIMES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
         ".webp": "image/webp", ".wav": "audio/wav", ".mp3": "audio/mpeg",
         ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".flac": "audio/flac",
         ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
         ".blend": "application/x-blender", ".json": "application/json",
         ".txt": "text/plain", ".srt": "application/x-subrip", ".ass": "text/plain", ".zip": "application/zip"}


_physical_hashes = ContextVar('production_physical_hashes', default=None)


def _file_identity(path):
    if path.is_symlink():
        raise ValueError('managed media cannot be a symlink')
    stat = path.stat()
    return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)


@contextmanager
def physical_hash_scope():
    """Reuse verified physical bytes only for this publication/export operation."""
    token = _physical_hashes.set({'files': {}, 'probes': {}, 'frozen': False})
    try:
        from .resources import lease_scope
        with lease_scope():
            yield
    finally:
        _physical_hashes.reset(token)


@contextmanager
def frozen_physical_hashes():
    """Reject changed/unprepared files rather than reading media under a DB lock."""
    scope = _physical_hashes.get()
    if scope is None:
        raise RuntimeError('physical media preflight scope is required')
    previous = scope['frozen']
    scope['frozen'] = True
    try:
        from .resources import frozen_scope
        with frozen_scope():
            yield
        validate_physical_hashes()
    finally:
        scope['frozen'] = previous


def validate_physical_hashes():
    """Recheck identities before a caller commits its database transaction."""
    scope = _physical_hashes.get()
    if scope is None:
        return
    for path, (identity, _) in scope['files'].items():
        if _file_identity(path) != identity:
            raise ValueError('media changed during preflight; retry operation')


def physical_file_hash(path):
    path = Path(path).absolute()
    scope = _physical_hashes.get()
    before = _file_identity(path)
    cached = scope['files'].get(path) if scope is not None else None
    if cached and cached[0] == before:
        return cached[1]
    if scope is not None and scope['frozen']:
        raise ValueError('media changed or was not preflighted; retry operation')
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    if _file_identity(path) != before:
        raise ValueError('media changed while hashing; retry operation')
    result = h.hexdigest()
    if scope is not None:
        scope['files'][path] = (before, result)
    return result


def file_hash(path):
    from .material_archives import reference, read_bytes
    if reference(path):return hashlib.sha256(read_bytes(path)).hexdigest()
    return physical_file_hash(path)


def asset_path(root, name):
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise ValueError("invalid production filename")
    return export_asset_path(root, name)


def export_asset_path(root, name):
    """Shared export assets also include named source figures and site icons."""
    bundle_asset_path(Path(root) / 'export', name)  # validate the legacy name
    from .resources import materialize
    return materialize(root, 'export/assets/' + name)


def bundle_asset_path(directory, name):
    if not isinstance(name, str) or not name or name != Path(name).name or name.startswith('.'):
        raise ValueError('unsafe asset name')
    folder = Path(directory) / 'assets'
    if folder.is_symlink() or (folder.parent.exists() and folder.parent.is_symlink()):
        raise ValueError("managed media directory cannot be a symlink")
    path = folder / name
    if path.is_symlink():
        raise ValueError("managed media cannot be a symlink")
    return path


def probe(path):
    path = Path(path).absolute()
    scope = _physical_hashes.get()
    before = _file_identity(path)
    saved = scope['probes'].get(path) if scope is not None else None
    if saved and saved[0] == before:
        return dict(saved[1])
    if scope is not None and scope['frozen']:
        raise ValueError('media metadata was not preflighted before the database transaction')
    result = _probe(path)
    if _file_identity(path) != before:
        raise ValueError('media changed during metadata inspection')
    if scope is not None:
        scope['probes'][path] = (before, dict(result))
    return result


def _probe(path):
    suffix = path.suffix.lower()
    mime = MIMES.get(suffix)
    if mime is None:
        raise ValueError("unsupported production file type")
    result = {"mime": mime}
    if mime.startswith(("image/", "audio/", "video/")):
        try:
            raw = subprocess.run(["ffprobe", "-v", "error", "-show_format", "-show_streams",
                                  "-of", "json", str(path)], capture_output=True, timeout=60, check=True)
            info = json.loads(raw.stdout)
        except (OSError, subprocess.SubprocessError, ValueError) as exc:
            raise ValueError("media cannot be inspected by ffprobe") from exc
        streams = info.get("streams", [])
        video = next((s for s in streams if s.get("codec_type") == "video"), None)
        audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
        still_codec = {".png": "png", ".jpg": "mjpeg", ".jpeg": "mjpeg", ".webp": "webp"}.get(suffix)
        if mime.startswith("image/") and (not video or video.get("codec_name") != still_codec):
            raise ValueError("file is not a supported still image")
        containers = {".wav": {"wav"}, ".mp3": {"mp3"}, ".flac": {"flac"}, ".ogg": {"ogg"},
                      ".m4a": {"mov", "mp4", "m4a"}, ".mp4": {"mov", "mp4"},
                      ".mov": {"mov"}, ".webm": {"webm", "matroska"}}
        if suffix in containers and not containers[suffix].intersection(info.get("format", {}).get("format_name", "").split(",")):
            raise ValueError("media container does not match its file extension")
        if mime.startswith("audio/") and (not audio or video and not video.get("disposition", {}).get("attached_pic")):
            raise ValueError("audio file does not contain the expected audio media")
        if mime.startswith("video/") and not video:
            raise ValueError("video file has no video stream")
        if video:
            result.update(width=int(video["width"]), height=int(video["height"]))
        if not mime.startswith("image/"):
            duration = float(info.get("format", {}).get("duration") or
                             next((s.get("duration") for s in streams if s.get("duration")), 0))
            if not math.isfinite(duration) or duration <= 0:
                raise ValueError("media duration is unavailable")
            result["duration_seconds"] = duration
            result["has_audio"] = bool(audio)
        if audio:
            result.update(sample_rate=int(audio["sample_rate"]), channels=int(audio["channels"]))
    elif suffix == ".json":
        try:
            from .material_archives import read_bytes
            json.loads(read_bytes(path))
        except (UnicodeError, ValueError) as exc:
            raise ValueError("invalid JSON file") from exc
    elif suffix == ".blend":
        with path.open("rb") as stream:
            header = stream.read(12)
        # Blender also supports gzip/zstd compressed blend files; these require
        # Blender verification at handoff, so this importer accepts plain files.
        if not header.startswith(b"BLENDER"):
            raise ValueError("expected an uncompressed Blender project")
    return result


def ingest(root, source, name, length=None):
    """Read a file/HTTP body in bounded chunks; only publish after inspection."""
    suffix = Path(name).suffix.lower()
    if suffix not in MIMES:
        raise ValueError("unsupported production file type")
    from . import resources
    cloud = resources.settings(root)
    folder = (resources.contained(root, '.runtime/resource-ingest') if cloud else Path(root)/'export/assets')
    bundle_asset_path(Path(root) / 'export', "0" * 64 + suffix)
    folder.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".ingest-", suffix=suffix, dir=folder)
    temp = Path(temporary)
    h, size = hashlib.sha256(), 0
    try:
        with os.fdopen(fd, "wb") as out:
            while length is None or size < length:
                chunk = source.read(min(1024 * 1024, length - size) if length is not None else 1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
                h.update(chunk)
                size += len(chunk)
                if size>8*1024**3:
                    raise ValueError('media exceeds the 8 GiB upload bound')
            out.flush()
            os.fsync(out.fileno())
        if size == 0 or length is not None and size != length:
            raise ValueError("empty or incomplete media upload")
        meta = probe(temp)
        filename = h.hexdigest() + suffix
        if cloud:
            resources.publish_file(root, 'export/assets/' + filename, temp, expected_sha=h.hexdigest(), mime=meta['mime'])
            return {"id": "original", "role": "original", "file": filename,
                    "sha256": h.hexdigest(), "bytes": size, **meta}
        destination = asset_path(root, filename)
        if destination.exists():
            if file_hash(destination) != h.hexdigest():
                raise ValueError("managed file checksum mismatch; refusing overwrite")
        else:
            # Hard-link is an atomic no-clobber publish on the same filesystem.
            try:
                os.link(temp, destination)
            except FileExistsError:
                if file_hash(destination) != h.hexdigest():
                    raise ValueError("concurrent media checksum mismatch")
        return {"id": "original", "role": "original", "file": filename,
                "sha256": h.hexdigest(), "bytes": size, **meta}
    finally:
        temp.unlink(missing_ok=True)


def validate_component(root, component, inspect=True):
    if not isinstance(component, dict) or not component.get("id") or component.get("role") not in (
            "original", "preview", "thumbnail", "project", "dependency", "metadata"):
        raise ValueError("invalid media component")
    path = asset_path(root, component.get("file"))
    from .material_archives import logical_size
    if not path.is_file() or type(component.get("bytes")) is not int or logical_size(path) != component["bytes"]:
        raise ValueError("missing media or byte size mismatch")
    if file_hash(path) != component.get("sha256") or path.stem != component["sha256"]:
        raise ValueError("media checksum mismatch")
    if inspect:
        actual = probe(path)
        for key, value in actual.items():
            saved = component.get(key)
            if isinstance(value, float):
                if type(saved) not in (int, float) or not math.isfinite(saved) or abs(saved - value) > 0.01:
                    raise ValueError("media metadata mismatch: " + key)
            elif saved != value:
                raise ValueError("media metadata mismatch: " + key)
    return path

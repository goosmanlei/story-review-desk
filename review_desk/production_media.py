"""Content-addressed production files; no platform URLs stand in for originals."""
import hashlib
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
         ".txt": "text/plain", ".zip": "application/zip"}


def file_hash(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def asset_path(root, name):
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise ValueError("invalid production filename")
    folder = Path(root) / "export" / "assets"
    if folder.is_symlink() or (folder.parent.exists() and folder.parent.is_symlink()):
        raise ValueError("managed media directory cannot be a symlink")
    path = folder / name
    if path.is_symlink():
        raise ValueError("managed media cannot be a symlink")
    return path


def probe(path):
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
            json.loads(path.read_text())
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
    folder = Path(root) / "export" / "assets"
    asset_path(root, "0" * 64 + suffix)  # validate directory before creating it
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
            out.flush()
            os.fsync(out.fileno())
        if size == 0 or length is not None and size != length:
            raise ValueError("empty or incomplete media upload")
        meta = probe(temp)
        filename = h.hexdigest() + suffix
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
    if not path.is_file() or type(component.get("bytes")) is not int or path.stat().st_size != component["bytes"]:
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

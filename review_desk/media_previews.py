"""Deterministic display derivatives; originals and business identities stay intact."""
import array
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading

VERSION = 'display-v1'
VARIANTS = {'small', 'large', 'poster', 'waveform'}


def checksum(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def _run(args):
    try:
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-threads', '1', *args],
                       check=True, timeout=300, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    except (OSError, subprocess.SubprocessError) as exc:
        raise ValueError('display derivative could not be generated') from exc


def _waveform(source, destination, duration):
    # Downmix only for a visual envelope. Playback always uses the exact original.
    # 8 kHz float samples are processed incrementally, never held for a whole film.
    count = 1600
    peaks = [0.0] * count
    process = subprocess.Popen(['ffmpeg', '-nostdin', '-v', 'error', '-threads', '1',
                                '-i', str(source), '-vn', '-ac', '1', '-ar', '8000',
                                '-f', 'f32le', '-'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    deadline=threading.Timer(300,process.kill)
    deadline.daemon=True
    deadline.start()
    position = 0
    try:
        while block := process.stdout.read(32768):
            samples = array.array('f')
            samples.frombytes(block)
            if sys.byteorder != 'little':
                samples.byteswap()
            for value in samples:
                index = min(count - 1, int(position * count / (8000 * duration)))
                if math.isfinite(value):
                    peaks[index] = max(peaks[index], abs(value))
                position += 1
        if process.wait(timeout=30):
            raise ValueError('waveform decoding failed')
    finally:
        deadline.cancel()
        process.stdout.close()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
    if not position:
        raise ValueError('waveform has no samples')
    destination.write_text(json.dumps({'format': VERSION, 'duration': duration,
                                       'peaks': [round(x, 5) for x in peaks]}, separators=(',', ':')))


def prepare(root, source, source_sha, variant, mime):
    """Return a verified local derivative and its content descriptor."""
    source = Path(source)
    def identity():
        stat = source.stat()
        return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
    before = identity()
    if source.is_symlink() or checksum(source) != source_sha or identity() != before:
        raise ValueError('display derivative source changed from its exact original')
    if variant not in VARIANTS:
        raise ValueError('unknown display variant')
    if variant == 'waveform' and not mime.startswith('audio/'):
        raise ValueError('waveform requires audio')
    if variant == 'poster' and not mime.startswith('video/'):
        raise ValueError('poster requires video')
    if variant in ('small', 'large') and not mime.startswith('image/'):
        raise ValueError('image preview requires an image')
    if mime in ('image/svg+xml', 'image/x-icon'):
        return Path(source), {'sha256': source_sha, 'bytes': Path(source).stat().st_size, 'mime': mime}
    folder = Path(root) / '.runtime' / 'media-previews' / VERSION / source_sha
    folder.mkdir(parents=True, exist_ok=True)
    extension = '.json' if variant == 'waveform' else '.webp'
    target = folder / (variant + extension)
    receipt = folder / (variant + '.receipt.json')
    with (folder / (variant + '.lock')).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if target.is_file() and receipt.is_file():
            saved = json.loads(receipt.read_text())
            if (saved.get('source_sha256') == source_sha and saved.get('recipe') == VERSION + '/' + variant
                    and target.stat().st_size == saved['bytes'] and checksum(target) == saved['sha256']):
                return target, saved
        fd, name = tempfile.mkstemp(suffix=extension, dir=folder)
        os.close(fd)
        temporary = Path(name)
        try:
            if variant == 'waveform':
                from .production_media import probe
                _waveform(source, temporary, probe(source)['duration_seconds'])
            else:
                edge = 1600 if variant == 'large' else 480
                from PIL import Image, ImageOps
                if variant == 'poster':
                    frame = temporary.with_suffix('.png')
                    try:
                        _run(['-i', str(source), '-frames:v', '1', '-vf',
                              f"scale='min({edge},iw)':'min({edge},ih)':force_original_aspect_ratio=decrease",
                              '-y', str(frame)])
                        with Image.open(frame) as image:
                            image.save(temporary, 'WEBP', quality=82)
                    finally:
                        frame.unlink(missing_ok=True)
                else:
                    # Preserve alpha and orientation; neither crop nor upscale.
                    with Image.open(source) as original:
                        image = ImageOps.exif_transpose(original)
                        image.thumbnail((edge, edge), Image.Resampling.LANCZOS)
                        image.save(temporary, 'WEBP', quality=82)
            if identity() != before:
                raise ValueError('display derivative source changed during processing')
            saved = {'sha256': checksum(temporary), 'bytes': temporary.stat().st_size,
                     'mime': 'application/json' if variant == 'waveform' else 'image/webp',
                     'source_sha256': source_sha, 'recipe': VERSION + '/' + variant}
            os.replace(temporary, target)
            receipt.write_text(json.dumps(saved, sort_keys=True) + '\n')
            return target, saved
        finally:
            temporary.unlink(missing_ok=True)

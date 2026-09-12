"""Stream an uploaded package into a new worker-owned directory."""
import os
import pathlib
import shutil
import sys
import tarfile

source, destination = map(pathlib.Path, sys.argv[1:])
destination.mkdir(mode=0o700, exist_ok=False)
seen, total = set(), 0
with tarfile.open(source, 'r|*') as archive:
    for member in archive:
        name = member.name.rstrip('/')
        parts = pathlib.PurePosixPath(name).parts
        if (not parts or parts[0] != 'package' or name.startswith('/') or
                any(p in ('', '.', '..') for p in name.split('/')) or '\\' in name or
                member.issym() or member.islnk() or not (member.isfile() or member.isdir())):
            raise ValueError('UNSAFE_PACKAGE_MEMBER')
        if name in seen or len(seen) >= 200000:
            raise ValueError('DUPLICATE_OR_EXCESSIVE_MEMBERS')
        seen.add(name)
        target = destination.joinpath(*parts)
        if member.isdir():
            target.mkdir(mode=0o700, parents=True, exist_ok=True)
            continue
        total += member.size
        if member.size < 0 or total > 64 * 1024**3 or shutil.disk_usage(destination).free - member.size < 8 * 1024**3:
            raise ValueError('PACKAGE_BUDGET')
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with archive.extractfile(member) as incoming, target.open('xb') as outgoing:
            os.chmod(target, 0o600)
            shutil.copyfileobj(incoming, outgoing, 1024**2)
        if target.stat().st_size != member.size:
            raise ValueError('TRUNCATED_PACKAGE_MEMBER')

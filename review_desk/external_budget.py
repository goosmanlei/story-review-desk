"""Optional persistent attempt cap; real API costs survive business resets."""
import fcntl
import json
import os
from pathlib import Path


def reserve():
    filename = os.environ.get('REVIEW_POLISH_BUDGET_FILE')
    if not filename:
        if os.environ.get('REVIEW_ENVIRONMENT') == 'experience':
            raise RuntimeError('体验 API 调用上限尚未配置')
        return
    maximum = int(os.environ.get('REVIEW_POLISH_MAX_ATTEMPTS', '0'))
    if maximum <= 0:
        raise RuntimeError('体验 API 调用上限尚未配置')
    path = Path(filename)
    if path.is_symlink() or path.parent.is_symlink():
        raise RuntimeError('API 用量目录不可使用符号链接')
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        value = json.loads(path.read_text()) if path.exists() else {'attempts':0}
        if value['attempts'] >= maximum:
            raise RuntimeError('体验 API 已达到累计调用上限，请联系实例维护者')
        value['attempts'] += 1
        temporary = path.with_suffix('.tmp')
        with temporary.open('w') as stream:
            json.dump(value, stream); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)

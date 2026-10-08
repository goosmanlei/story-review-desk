"""Optional persistent attempt cap; real API costs survive business resets."""
import fcntl
import json
import os
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo


def day():
    return datetime.now(ZoneInfo(os.environ.get('REVIEW_POLISH_BUDGET_TIMEZONE', 'Asia/Shanghai'))).date().isoformat()


def reserve():
    filename = os.environ.get('REVIEW_POLISH_BUDGET_FILE')
    if not filename:
        if os.environ.get('REVIEW_ENVIRONMENT') == 'experience':
            raise RuntimeError('体验 API 调用上限尚未配置')
        return
    maximum = int(os.environ.get('REVIEW_POLISH_MAX_ATTEMPTS', '0'))
    daily = int(os.environ.get('REVIEW_POLISH_DAILY_LIMIT', '0'))
    if maximum <= 0 and daily <= 0:
        raise RuntimeError('体验 API 调用上限尚未配置')
    path = Path(filename)
    if path.is_symlink() or path.parent.is_symlink():
        raise RuntimeError('API 用量目录不可使用符号链接')
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        value = json.loads(path.read_text()) if path.exists() else {'attempts':0}
        total = value.get('total_attempts', value['attempts'])
        if maximum > 0 and total >= maximum:
            raise RuntimeError('体验 API 已达到累计调用上限，请联系实例维护者')
        if daily > 0:
            today = day()
            attempts = value['attempts'] if value.get('date', today) == today else 0
            if attempts >= daily:
                raise RuntimeError('体验 API 已达到今日调用上限，请明天再试')
            value = {'date':today, 'attempts':attempts, 'total_attempts':total+1}
        elif 'total_attempts' in value:
            value = {'attempts':total}
        value['attempts'] += 1
        temporary = path.with_suffix('.tmp')
        with temporary.open('w') as stream:
            json.dump(value, stream); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)

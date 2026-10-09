"""Task-preview-only HTTP fault fixture for real browser decision checks."""
import argparse
import json
import time
import threading
from pathlib import Path

from review_desk.server import ReviewHandler, ReviewServer


class FaultHandler(ReviewHandler):
    def do_GET(self):
        control = self.server.fault_file
        with self.server.fault_lock:
            fault = json.loads(control.read_text()) if control.exists() else {}
            matches = (self.path.startswith('/api/comment-review/content?')
                       if fault.get('mode') != 'image-missing' else self.path.split('?')[0] == fault.get('path'))
            if matches:
                control.write_text('{}\n')
        if matches:
            if fault.get('mode') in ('delay', 'delay-failure'):
                time.sleep(min(3, max(0, float(fault.get('seconds', 2)))))
            if fault.get('mode') in ('missing', 'delay-failure', 'image-missing'):
                return self._json({'error': '隔离验收：准确目标已不可用；未替换为最新稿'}, 404)
        return super().do_GET()

    def do_PATCH(self):
        control = self.server.fault_file
        fault = json.loads(control.read_text()) if control.exists() else {}
        cid = self.path.removeprefix('/api/comments/')
        if fault.get('comment_id') == cid:
            control.write_text('{}\n')
            if fault.get('mode') == 'failure':
                self._input()
                return self._json({'error': '隔离验收：保存失败，当前输入与决定仍保留'}, 503)
            if fault.get('mode') == 'concurrent':
                comment = self.server.store.comment(cid)
                self.server.store.change_comment(cid, 'CLOSE' if comment['status'] == 'OPEN' else 'REOPEN', comment['version'])
        return super().do_PATCH()


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--instance', type=Path, required=True)
    p.add_argument('--fault-file', type=Path, required=True)
    p.add_argument('--port', type=int, required=True)
    a = p.parse_args()
    root = a.instance.resolve()
    config = json.loads((root / 'config/instance.json').read_text())
    if '任务预览' not in config['title'] or '.codex-task/worktrees/' not in str(root):
        raise ValueError('fault injection is restricted to a managed task preview')
    with ReviewServer(('127.0.0.1', a.port), root, config) as server:
        server.RequestHandlerClass = FaultHandler
        server.fault_file = a.fault_file.resolve()
        server.fault_lock = threading.Lock()
        print('隔离故障验收：http://127.0.0.1:%s/' % server.server_port, flush=True)
        try: server.serve_forever()
        except KeyboardInterrupt: pass


if __name__ == '__main__': main()

"""Task-preview-only HTTP fault fixture for real browser decision checks."""
import argparse
import json
from pathlib import Path

from review_desk.server import ReviewHandler, ReviewServer


class FaultHandler(ReviewHandler):
    def do_GET(self):
        control = self.server.fault_file
        fault = json.loads(control.read_text()) if control.exists() else {}
        if fault.get('mode') == 'missing' and self.path.startswith('/api/comment-review/content?'):
            control.write_text('{}\n')
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
        print('隔离故障验收：http://127.0.0.1:%s/' % server.server_port, flush=True)
        try: server.serve_forever()
        except KeyboardInterrupt: pass


if __name__ == '__main__': main()

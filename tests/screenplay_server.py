"""Disposable browser fixture; never uses a story instance or AI credentials.

PYTHONPATH=.:tests python3 tests/screenplay_server.py --port 8793 --evidence /tmp/screenplay-ui.json
Open /screenplay-tests and run the page's checks; / is available for manual drag tests.
"""
import argparse
import json
from pathlib import Path
from review_desk.server import ReviewServer, ReviewHandler
from review_desk.screenplay import import_screenplay
from test_screenplay import ScreenplayTest

class Handler(ReviewHandler):
    def do_GET(self):
        if self.path == '/screenplay-tests':
            return self._file(Path(__file__).with_name('screenplay.html'), 'text/html; charset=utf-8')
        super().do_GET()

    def do_POST(self):
        if self.path == '/test-results':
            value = self._input()
            if self.server.evidence:
                self.server.evidence.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
            return self._json({'recorded': True})
        super().do_POST()

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8793);parser.add_argument('--evidence',type=Path)
    args=parser.parse_args();fixture=ScreenplayTest();fixture.setUp()
    for id in ('script-one','script-two'):
        d=fixture.edition(id)
        d['episodes'][0]['blocks'][-1]['text']='长段落，检查定位是否到引用，而非整块中间。\n'*70+'末尾定位目标。'
        d['episodes'][0]['scenes']=[
            {'id':'s1','heading':'场一·庙后','location':'庙后','time':'外景·日',
             'estimated_seconds':120,'block_ids':['a']},
            {'id':'s2','heading':'场二·门闩','location':'庙门','time':'内景·夜',
             'estimated_seconds':120,'block_ids':['b']},
        ]
        import_screenplay(fixture.store,d)
    fixture.store.close()
    try:
        with ReviewServer(('127.0.0.1',args.port),fixture.root,{'id':'screenplay-ui-test','title':'剧本隔离测试（可丢弃）'}) as server:
            server.RequestHandlerClass=Handler;server.evidence=args.evidence
            print(f'http://127.0.0.1:{args.port}/screenplay-tests',flush=True)
            server.serve_forever()
    finally:
        fixture.temp.cleanup()

if __name__=='__main__':main()

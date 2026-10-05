"""Create disposable UI cases; synthetic audio is never a real generation receipt."""
import argparse
import copy
import io
import shutil
import wave
from pathlib import Path
from test_generation import GenerationTest
from review_desk import production as p
from review_desk.production_media import ingest


def create(destination):
    destination = Path(destination).resolve()
    if destination.exists():
        raise ValueError('fixture must be new')
    fixture = GenerationTest()
    fixture.setUp()
    try:
        fixture.setup_plans()
        fixture.media()
        fixture.associate()
        fixture.change('voice', candidate_requirements=[fixture.ref('need-full-overall')])
        data = io.BytesIO()
        with wave.open(data, 'wb') as audio:
            audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(48000)
            audio.writeframes(b'\x01\x00' * 48000)
        data.seek(0)
        component = ingest(fixture.root, data, 'synthetic-second.wav')
        asset = copy.deepcopy(p.record(fixture.store, 'voice')['payload'])
        asset['title'] = '隔离测试候选二（合成音频）'
        asset['components'] = [component]
        fixture.put({'object_id':'voice-two', 'kind':'ASSET', 'expected_version':0, 'payload':asset})
        plan = copy.deepcopy(p.record(fixture.store, 'need-full-overall')['payload']['generation'])
        plan['prompt'] = '隔离测试新版，未生成'
        fixture.change('need-full-overall', generation=plan)
        fixture.store.close()
        shutil.copytree(fixture.root, destination)
    finally:
        fixture.tearDown()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination', type=Path)
    create(parser.parse_args().destination)

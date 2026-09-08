import test from 'node:test';
import assert from 'node:assert/strict';
import { instanceCandidateRelativePath } from '../media-paths.mjs';

test('formal legacy audio retains its logical path and resolves to the exact instance family', () => {
  const logical = 'production/generated/05_audio/voices/JTA_VOICE_TEST_V001.wav';
  assert.equal(instanceCandidateRelativePath(logical, 'VOICE-TEST-V001'),
    'media/_review_pending/VOICE-TEST-V001/JTA_VOICE_TEST_V001.wav');
  for (const family of [undefined, '', '../wrong', 'a/b']) {
    assert.throws(() => instanceCandidateRelativePath(logical, family), { code: 'INVALID_MEDIA_PATH' });
  }
  for (const path of ['production/generated/05_audio/../outside.wav',
    'production/generated/05_audio/test.png', 'production/generated/04_images/test.wav']) {
    assert.throws(() => instanceCandidateRelativePath(path, 'VOICE-TEST-V001'), { code: 'INVALID_MEDIA_PATH' });
  }
});

test('existing pending mappings remain byte-for-byte compatible', () => {
  const legacy = 'production/generated/05_audio/_review_pending/voice/voice.wav';
  assert.equal(instanceCandidateRelativePath(legacy, 'VOICE-TEST-V001'), `media/_review_pending/legacy-targets/${legacy}`);
  const native = 'media/_review_pending/VOICE-TEST-V001/voice.wav';
  assert.equal(instanceCandidateRelativePath(native, 'VOICE-TEST-V001'), native);
});

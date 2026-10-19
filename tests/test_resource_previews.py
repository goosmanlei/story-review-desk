import hashlib,json,math,os,struct,subprocess,sys,tempfile,unittest,wave
from pathlib import Path
from unittest.mock import patch
from review_desk import media_previews as p
from PIL import Image
class PreviewsPrivate(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='preview-case-');self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
 def image(self,name='source.png',size=(2400,1200)):
  source=self.root/name;Image.new('RGBA',size,(40,80,120,100)).save(source);return source
 def test_small_large_preserve_ratio_alpha_and_original(self):
  source=self.image();sha=p.checksum(source)
  for variant,size in [('small',(480,240)),('large',(1600,800))]:
   target,spec=p.prepare(self.root,source,sha,variant,'image/png')
   with Image.open(target) as result:self.assertEqual(result.size,size);self.assertIn('A',result.mode)
   self.assertEqual(spec['source_sha256'],sha);self.assertEqual(p.checksum(target),spec['sha256']);self.assertEqual(p.checksum(source),sha)
 def test_exif_orientation_and_no_upscale(self):
  source=self.root/'source.jpg';img=Image.new('RGB',(60,30),(40,80,120));exif=Image.Exif();exif[274]=6;img.save(source,exif=exif)
  target,spec=p.prepare(self.root,source,p.checksum(source),'large','image/jpeg')
  with Image.open(target) as result:self.assertEqual(result.size,(30,60))
 def test_waveform_is_small_and_uses_original_duration(self):
  source=self.root/'source.wav'
  with wave.open(str(source),'wb') as target:
   target.setparams((1,2,8000,8000,'NONE','not compressed'));target.writeframes(b''.join(struct.pack('<h',int(10000*math.sin(i/20))) for i in range(8000)))
  target,spec=p.prepare(self.root,source,p.checksum(source),'waveform','audio/wav');value=json.loads(target.read_text())
  self.assertAlmostEqual(value['duration'],1);self.assertEqual(len(value['peaks']),1600);self.assertLess(target.stat().st_size,20000);self.assertEqual(spec['mime'],'application/json')
 def test_changed_source_is_rejected_before_generation_or_cache_hit(self):
  source=self.image(size=(40,20));sha=p.checksum(source)
  p.prepare(self.root,source,sha,'small','image/png')
  Image.new('RGB',(40,20),'blue').save(source)
  for variant in ('small','large'):
   with self.assertRaisesRegex(ValueError,'source changed'):
    p.prepare(self.root,source,sha,variant,'image/png')
 def test_source_replaced_during_generation_never_activates_derivative(self):
  from PIL import ImageOps
  source=self.image(size=(40,20));sha=p.checksum(source);original=ImageOps.exif_transpose
  def mutate(image):
   result=original(image);Image.new('RGB',(40,20),'blue').save(source);return result
  with patch.object(ImageOps,'exif_transpose',side_effect=mutate):
   with self.assertRaisesRegex(ValueError,'source changed during'):
    p.prepare(self.root,source,sha,'small','image/png')
  self.assertFalse((self.root/'.runtime/media-previews'/p.VERSION/sha/'small.webp').exists())
 def test_video_poster_preserves_ratio(self):
  source=self.root/'source.mp4';subprocess.run(['ffmpeg','-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=640x360:r=1','-frames:v','1','-c:v','libx264','-threads','1',str(source)],check=True,timeout=10)
  target,spec=p.prepare(self.root,source,p.checksum(source),'poster','video/mp4')
  with Image.open(target) as result:self.assertEqual(result.size,(480,270))
if __name__=='__main__':unittest.main()

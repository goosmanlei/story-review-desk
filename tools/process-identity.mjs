// Kernel process birth identity, independent of locale and display timezone.
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {bootStamp,compareBootIdentity} from './execution-runtime.mjs';

const unknown=detail=>Error('EXECUTION_PROCESS_UNKNOWN：'+detail+'，保留占用');
const sources=new Set(['darwin-proc-bsdinfo-v1','linux-proc-stat-v1']);
const darwinProbe=String.raw`
import ctypes, errno, json, sys
class BsdInfo(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in ('flags','status','xstatus','pid','ppid','uid','gid','ruid','rgid','svuid','svgid','reserved')] + [('comm',ctypes.c_char*16),('name',ctypes.c_char*32)] + [(name,ctypes.c_uint32) for name in ('nfiles','pgid','pjobc','tdev','tpgid')] + [('nice',ctypes.c_int32),('start_sec',ctypes.c_uint64),('start_usec',ctypes.c_uint64)]
assert ctypes.sizeof(BsdInfo) == 136
lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
lib.proc_pidinfo.argtypes = [ctypes.c_int,ctypes.c_int,ctypes.c_uint64,ctypes.c_void_p,ctypes.c_int]
lib.proc_pidinfo.restype = ctypes.c_int
pid = int(sys.argv[1]); info = BsdInfo()
size = lib.proc_pidinfo(pid,3,0,ctypes.byref(info),ctypes.sizeof(info))
if size <= 0 and ctypes.get_errno() in (errno.ESRCH, errno.ENOENT):
    print('null')
elif size != ctypes.sizeof(info) or info.pid != pid or info.start_sec <= 0 or info.start_usec >= 1000000:
    raise RuntimeError('kernel process identity unavailable')
elif info.status == 5:
    print('null')
else:
    print(json.dumps({'birthId':str(info.start_sec)+'.'+str(info.start_usec).zfill(6),'birthSource':'darwin-proc-bsdinfo-v1'}))
`;

export function readKernelProcess(pid,{platform=process.platform,read=readFileSync,exec=execFileSync}={}) {
  if(!Number.isInteger(pid)||pid<=0||pid>2147483647)throw unknown('无效 PID');
  try {
    if(platform==='darwin') {
      const value=JSON.parse(exec(process.env.REVIEW_PROCESS_PYTHON||'python3',['-c',darwinProbe,String(pid)],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']}));
      if(value===null)return null;
      if(value?.birthSource!=='darwin-proc-bsdinfo-v1'||!/^\d+\.\d{6}$/.test(value.birthId))throw unknown('内核出生时间无效');
      return value;
    }
    if(platform==='linux') {
      const value=read('/proc/'+pid+'/stat','utf8'),end=value.lastIndexOf(') ');
      if(!value.startsWith(pid+' (')||end<0)throw unknown('内核进程记录无效');
      const fields=value.slice(end+2).trim().split(/\s+/);
      if(fields[0]==='Z'||fields[0]==='X')return null;
      if(!/^[A-Za-z]$/.test(fields[0])||!/^\d+$/.test(fields[19]))throw unknown('缺少内核出生时钟');
      return {birthId:fields[19],birthSource:'linux-proc-stat-v1'};
    }
    throw unknown('不支持当前系统的内核进程身份');
  } catch(error) {
    if(platform==='linux'&&error.code==='ENOENT')return null;
    throw unknown('无法核验内核进程身份');
  }
}

export function processIdentity(pid=process.pid,{includeLegacy=false}={}) {
  const kernel=readKernelProcess(pid);
  if(!kernel)return null;
  const identity={pid,...kernel,birth:kernel.birthSource==='darwin-proc-bsdinfo-v1'?new Date(Number(kernel.birthId)*1000).toISOString():'start-ticks:'+kernel.birthId,...bootStamp()};
  if(includeLegacy) {
    let display;
    try {display=execFileSync('ps',['-p',String(pid),'-o','lstart=','-o','stat='],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']}).trim().match(/^(.+?)\s+(\S+)$/);}
    catch(error){if(error.status!==1)throw unknown('无法读取旧格式进程身份');}
    const after=readKernelProcess(pid);
    if(!after)return null;
    if(after.birthId!==kernel.birthId||after.birthSource!==kernel.birthSource||!display||display[2].includes('Z'))throw unknown('读取期间进程身份发生变化');
    identity.legacyBirth=display[1];
  }
  return identity;
}

export function processAlive(owner,{inspect=processIdentity,compareBoot=compareBootIdentity}={}) {
  if(!owner)return false;
  if(!Number.isInteger(owner.pid)||owner.pid<=0||typeof owner.birth!=='string'||!owner.birth.trim())throw unknown('缺少原进程 PID 或出生时间');
  const now=inspect(owner.pid,{includeLegacy:!owner.birthSource});
  if(now===null)return false;
  if(!now||now.pid!==owner.pid)throw unknown('无法读取当前进程身份');
  const stable=sources.has(owner.birthSource)&&owner.birthSource===now.birthSource&&typeof owner.birthId==='string'&&owner.birthId&&typeof now.birthId==='string'&&now.birthId;
  if(stable&&owner.birthId!==now.birthId)return false;
  const boot=compareBoot(owner);
  if(boot==='DIFFERENT')return false;
  // Unmarked lstart strings have no locale/TZ contract. A mismatch cannot
  // distinguish PID reuse from a display change and never permits takeover.
  if(!stable&&(owner.birthSource||owner.birth!==(now.legacyBirth??now.birth)))throw unknown('旧出生时间格式或当前显示无法比较');
  if(boot!=='SAME')throw Error('EXECUTION_BOOT_UNKNOWN：存活进程的旧启动身份无法核验，保留占用，不能接管');
  return true;
}

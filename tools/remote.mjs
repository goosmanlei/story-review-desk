import { mkdir, cp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { exportPackage } from "../server/project/package.mjs";
import { fileSha } from "../server/transport-contract.mjs";
import {
  run,
  json,
  atomic,
  requireValue,
  exists,
  shellQuote,
  verifyTree,
} from "./io.mjs";
import {
  phaseRecords,
  ProcessPhase,
  readProcessConfig,
  releaseConsumer,
} from "./process-resources.mjs";

const sshArgs = (host) => [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ConnectionAttempts=1",
  host,
];
export function checkRemoteConnection(host, { execute = run } = {}) {
  try {
    execute("ssh", [...sshArgs(host), "true"], { timeout: 12000 });
    return { connected: true };
  } catch (error) {
    return {
      connected: false,
      reason: String(error.stderr || error.message)
        .trim()
        .slice(0, 600),
    };
  }
}
export const bootstrap = `import sys,os,json,fcntl,pathlib,hashlib,tarfile,shutil,subprocess
root,op,sha=sys.argv[1:4]
if not os.path.isabs(root) or any(x in op for x in '/\\\\') or not op: raise Exception('invalid target')
r=pathlib.Path(root)
if r.exists() and not (r/'instance/instance.json').exists() and any(x.name!='.process' for x in r.iterdir()): raise Exception('existing target is not a standard project')
r.mkdir(parents=True,exist_ok=True,mode=0o700)
base=r/'.process'/'transport'/op
base.mkdir(parents=True,exist_ok=True,mode=0o700)
lockdir=r/'.process'/'transport-locks';lockdir.mkdir(parents=True,exist_ok=True)
lock=open(lockdir/(op+'.lock'),'a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
owner=base/'ownership.json'
if owner.exists():
 old=json.load(open(owner));assert old['operationId']==op and old['sha256']==sha
else:
 json.dump({'operationId':op,'sha256':sha,'root':root},open(owner,'x'))
part=base/'bundle.part';final=base/'bundle.tar.gz'
if len(sys.argv)>4 and sys.argv[4]=='upload':
 h=hashlib.sha256();total=0
 with open(part,'wb') as f:
  while True:
   block=sys.stdin.buffer.read(1024*1024)
   if not block: break
   total+=len(block)
   if total>64*1024**3 or shutil.disk_usage(base).free<8*1024**3: raise Exception('space budget')
   h.update(block);f.write(block)
  f.flush();os.fsync(f.fileno())
 assert h.hexdigest()==sha,'transfer SHA mismatch'
 os.replace(part,final)
 print(json.dumps({'status':'UPLOADED','operationId':op}),flush=True)
else:
 assert final.exists()
 h=hashlib.sha256()
 with open(final,'rb') as f:
  for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
 assert h.hexdigest()==sha
 unpack=base/'unpacked';partial=base/'extracting'
 def verify_input(directory,allow_partial=False):
  with tarfile.open(final,'r:gz') as archive:
   members=archive.getmembers();expected={str(pathlib.PurePosixPath(m.name)):m for m in members if m.isfile()}
   for current in directory.rglob('*'):
    assert not current.is_symlink(),'unexpected symbolic link'
    if current.is_dir():continue
    rel=str(current.relative_to(directory));m=expected.get(rel);assert m is not None,'unexpected transport file'
    assert current.stat().st_size<=m.size if allow_partial else current.stat().st_size==m.size
    with open(current,'rb') as actual, archive.extractfile(m) as original:
     while True:
      block=actual.read(1024*1024)
      if not block:break
      assert block==original.read(len(block)),'modified transport file'
   if not allow_partial:assert set(str(p.relative_to(directory)) for p in directory.rglob('*') if p.is_file())==set(expected)
 if partial.exists():verify_input(partial,True);shutil.rmtree(partial)
 if not unpack.exists():
  partial.mkdir(mode=0o700)
  with tarfile.open(final,'r:gz') as t:
   members=t.getmembers();assert sum(x.size for x in members)<64*1024**3
   for m in members:
    p=pathlib.PurePosixPath(m.name);assert not p.is_absolute() and '..' not in p.parts and (m.isfile() or m.isdir())
   t.extractall(partial)
  verify_input(partial);os.replace(partial,unpack)
 else:verify_input(unpack)
 node=sys.argv[5] if len(sys.argv)>5 else 'node'
 os.chdir(root)
 code=subprocess.call([node,str(unpack/'software/tools/remote-target.mjs'),root,op,str(base)])
 receipt=r/'instance'/'runtime'/'deployments'/(op+'.json')
 if receipt.exists():
  value=json.load(open(receipt))
  if value.get('cleanup')=='TRANSPORT_PENDING' and value.get('status') in ['SUCCEEDED','FAILED']:
   assert json.load(open(owner))['sha256']==sha
   # The transport contains only immutable input. Refuse unrecognized siblings.
   assert set(p.name for p in base.iterdir())<=set(['ownership.json','bundle.tar.gz','bundle.part','unpacked'])
   verify_input(unpack)
   shutil.rmtree(base)
   value['cleanup']='CLEANED'
   temporary=receipt.with_suffix('.transport.tmp')
   with open(temporary,'x') as f:json.dump(value,f);f.flush();os.fsync(f.fileno())
   os.replace(temporary,receipt)
   code=0 if value['status']=='SUCCEEDED' else 1
 sys.exit(code)
`;
async function transport(host, args, { inputFile, inputText } = {}) {
  const command =
      "python3 -c " +
      shellQuote(bootstrap) +
      " " +
      args.map(shellQuote).join(" "),
    child = spawn("ssh", [...sshArgs(host), command], {
      stdio: ["pipe", "pipe", "pipe"],
    });
  let output = "",
    error = "";
  child.stdout.on("data", (b) => {
    output = (output + b).slice(-1024 * 1024);
  });
  child.stderr.on("data", (b) => {
    error = (error + b).slice(-16000);
  });
  child.stdin.on("error", () => {});
  if (inputFile) {
    const { createReadStream } = await import("node:fs");
    createReadStream(inputFile).pipe(child.stdin);
  } else child.stdin.end(inputText);
  const [code] = await once(child, "exit");
  requireValue(code === 0, "VPS 执行失败：" + (error || output).slice(-2000));
  return output;
}
export async function deployRemote(
  root,
  { operationId, commit, frozen, manifest, phase, target, resume, save },
) {
  const connection = checkRemoteConnection(target.sshHost);
  if (!connection.connected)
    return {
      status:
        resume &&
        (await exists(
          path.join(
            root,
            ".process/shared",
            operationId + "-remote/frozen.json",
          ),
        ))
          ? "RESULT_UNKNOWN"
          : "SKIPPED",
      stage:
        resume &&
        (await exists(
          path.join(
            root,
            ".process/shared",
            operationId + "-remote/frozen.json",
          ),
        ))
          ? "RESULT_UNKNOWN"
          : "CONNECTIVITY",
      reason: connection.reason,
    };
  const task = (await phase.read()).taskId,
    consumer = "remote-" + operationId,
    input = path.join(root, ".process/shared", operationId + "-remote"),
    bundle = path.join(input, "bundle.tar.gz");
  let frozenInput;
  if (await exists(input)) {
    requireValue(resume, "VPS 输入已存在，请按原操作续作");
    frozenInput = await json(path.join(input, "frozen.json"));
    requireValue(
      frozenInput.commit === commit &&
        frozenInput.target.projectRoot === target.projectRoot &&
        frozenInput.target.sshHost === target.sshHost,
      "续作目标或提交发生改变",
    );
    requireValue(
      (await fileSha(bundle)) === frozenInput.bundleSha256,
      "冻结传输包已改变",
    );
  } else {
    await phase.directory(input);
    const payload = path.join(input, "payload");
    await mkdir(payload);
    await cp(frozen, path.join(payload, "software"), { recursive: true });
    await atomic(path.join(payload, "software-manifest.json"), manifest);
    const machine = await json(
        path.join(root, "instance/runtime/machine.json"),
      ),
      instance = await json(path.join(root, "instance/instance.json"));
    const business = await exportPackage(
      machine.apiUrl,
      path.join(payload, "business"),
    );
    await atomic(path.join(payload, "request.json"), {
      schemaVersion: "1.0",
      operationId,
      commit,
      title: instance.title,
      originInstanceId: instance.id,
      target: {
        projectRoot: target.projectRoot,
        port: target.port || 3000,
        listenHost: target.listenHost || "127.0.0.1",
      },
      baselineSha256: business.transfer.sha256,
    });
    run("tar", ["-czf", bundle, "-C", payload, "."], { timeout: 600000 });
    frozenInput = {
      operationId,
      commit,
      target,
      bundleSha256: await fileSha(bundle),
      baselineSha256: business.transfer.sha256,
    };
    await atomic(path.join(input, "frozen.json"), frozenInput);
    await rm(payload, { recursive: true });
    await phase.transfer("path", input, consumer);
  }
  await save({
    stage: "TRANSFERRING",
    baselineSha256: frozenInput.baselineSha256,
  });
  await phase.hostReceipt("vps-bj", {
    status: "CLEANUP_REQUIRED",
    operationId,
    root: target.projectRoot,
  });
  try {
    await transport(
      target.sshHost,
      [target.projectRoot, operationId, frozenInput.bundleSha256, "upload"],
      { inputFile: bundle },
    );
    await save({ stage: "REMOTE_STARTED" });
    await transport(target.sshHost, [
      target.projectRoot,
      operationId,
      frozenInput.bundleSha256,
      "run",
      target.nodeBinary || "node",
    ]);
  } catch (error) {
    const remoteFile = path.posix.join(
      target.projectRoot,
      "instance/runtime/deployments",
      operationId + ".json",
    );
    let receipt;
    try {
      receipt = JSON.parse(
        run(
          "ssh",
          [...sshArgs(target.sshHost), "cat " + shellQuote(remoteFile)],
          { timeout: 12000 },
        ),
      );
    } catch {}
    if (
      !receipt ||
      !["SUCCEEDED", "FAILED"].includes(receipt.status) ||
      receipt.cleanup !== "CLEANED"
    ) {
      await save({ stage: "RESULT_UNKNOWN", error: error.message });
      return { status: "RESULT_UNKNOWN", error: error.message };
    }
    await clearRemote(root, task, consumer, operationId, receipt);
    return {
      status: receipt.status,
      stage: "REMOTE_FINISHED",
      remote: receipt,
      error: receipt.error,
    };
  }
  const remoteFile = path.posix.join(
      target.projectRoot,
      "instance/runtime/deployments",
      operationId + ".json",
    ),
    receipt = JSON.parse(
      run(
        "ssh",
        [...sshArgs(target.sshHost), "cat " + shellQuote(remoteFile)],
        { timeout: 12000 },
      ),
    );
  requireValue(
    receipt.commit === commit &&
      receipt.baselineSha256 === frozenInput.baselineSha256 &&
      receipt.cleanup === "CLEANED",
    "VPS 运行或清理回执与冻结输入不符",
  );
  await clearRemote(root, task, consumer, operationId, receipt);
  return { status: receipt.status, stage: "REMOTE_FINISHED", remote: receipt };
}
async function clearRemote(root, task, consumer, operationId, receipt) {
  const policy = await readProcessConfig(root);
  for (const { file, record } of await phaseRecords(root, task)) {
    if (record.hosts?.["vps-bj"]?.operationId !== operationId) continue;
    await new ProcessPhase(policy, file, record.token).hostReceipt("vps-bj", {
      status: "CLEANED",
      operationId,
      receipt,
    });
  }
  await releaseConsumer(root, task, consumer);
}

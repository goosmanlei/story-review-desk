"""Host protocol companion; all repository access uses the verified owner CLI.

A running Docker instance never opens SQLite on the host. Native offline instances
also use the repository CLI, leaving SQLite policy and CAS in one implementation.
"""
from __future__ import annotations
import base64
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
from types import MappingProxyType

class InstanceStorageError(RuntimeError):
    pass

class InstanceStorage:
    def __init__(self, root: Path):
        self.root=root.expanduser().resolve(strict=True)
        bootstrap_path=self.root/"instance.json"
        if bootstrap_path.is_symlink() or not bootstrap_path.is_file() or bootstrap_path.stat().st_size>65536:
            raise InstanceStorageError("Invalid instance bootstrap")
        bootstrap=json.loads(bootstrap_path.read_text())
        if not isinstance(bootstrap.get("instanceId"),str) or not bootstrap["instanceId"]:
            raise InstanceStorageError("Invalid instance identity")
        self.backend="postgres" if bootstrap.get("schemaVersion")=="2.0" else "sqlite"
        if self.backend=="postgres":
            locator=bootstrap.get("database")
            if not isinstance(locator,dict) or set(locator)!={"kind","database","service","volume"} or locator.get("kind")!="postgres":
                raise InstanceStorageError("Invalid PostgreSQL locator")
            self.database=None
            self.file_identity=None
            self.bootstrap_sha256=hashlib.sha256(bootstrap_path.read_bytes()).hexdigest()
        else:
            if bootstrap.get("schemaVersion")!="1.0" or bootstrap.get("database")!="data/review.sqlite":
                raise InstanceStorageError("Invalid SQLite locator")
            self.database=self.root/bootstrap["database"]
            if self.database.is_symlink() or not self.database.resolve(strict=True).is_relative_to(self.root):
                raise InstanceStorageError("Database escaped instance")
            info=self.database.stat()
            self.file_identity=(info.st_dev,info.st_ino)
        self.instance_id=bootstrap["instanceId"]
        self.owner_hash=self._owner_hash()
        self.cli=Path(__file__).parent/"instance-runtime"/"transport.mjs"
        self.node=os.environ.get("REVIEW_NODE_BINARY") or shutil.which("node")
        if not self.node:
            raise InstanceStorageError("Node runtime is required for repository transport")
        # Capture only transport configuration before the SDK isolates os.environ.
        # Keep it private to child CLI processes; never restore it into the SDK's
        # environment or allow later environment changes to remove read-only mode.
        allowed=("PATH","HOME","LANG","LC_ALL","TMPDIR","DOCKER_HOST","DOCKER_CONTEXT","DOCKER_CONFIG","DOCKER_TLS_VERIFY","DOCKER_CERT_PATH","REVIEW_INSTANCE_READ_ONLY")
        self._transport_env=MappingProxyType({key:os.environ[key] for key in allowed if key in os.environ})
        self.public_root=self.root/"runtime"/"assistant"/"public"
        self.private_root=self.root/"runtime"/"assistant"/"private"
        current=self._command("host-profile",[])
        self.runtime_epoch=current.get("runtimeEpoch")
        self.execution_protocol=current.get("executionProtocol")
        self.profile_revision=current.get("profileRevisionId")
        self.profile=current.get("profile",{})
        if current.get("instanceId")!=self.instance_id or self.profile.get("instanceId")!=self.instance_id or not self.runtime_epoch or not self.profile_revision:
            raise InstanceStorageError("Profile, epoch or release identity is incomplete")
        assistant=self.profile.get("assistant",{})
        for key in ("scopeKey","schedulerProtocol","conversationHashNamespace","archiveHashNamespace","contextMode"):
            if not isinstance(assistant.get(key),str) or not assistant[key]:
                raise InstanceStorageError("Assistant profile is incomplete")

    def _owner_hash(self):
        marker=self.root/"runtime"/"storage-owner.json"
        if marker.is_symlink():
            raise InstanceStorageError("Storage owner marker cannot be a symlink")
        try:
            return hashlib.sha256(marker.read_bytes()).hexdigest()
        except FileNotFoundError:
            return "NONE"

    def _command(self,command,flags,body=None,bind_profile=False):
        if self.backend=="postgres":
            bootstrap_path=self.root/"instance.json"
            if bootstrap_path.is_symlink() or hashlib.sha256(bootstrap_path.read_bytes()).hexdigest()!=self.bootstrap_sha256:
                raise InstanceStorageError("PostgreSQL locator changed; restart required")
        else:
            info=self.database.stat()
            if self.database.is_symlink() or (info.st_dev,info.st_ino)!=self.file_identity:
                raise InstanceStorageError("Repository file was replaced; restart required")
        if self._owner_hash()!=self.owner_hash:
            raise InstanceStorageError("Storage owner changed; restart required")
        args=[self.node,str(self.cli),command,"--instance",str(self.root),"--expected-storage-owner-hash",self.owner_hash,*flags]
        if hasattr(self,"runtime_epoch"):
            args.extend(["--expected-runtime-epoch",self.runtime_epoch])
        if bind_profile:
            args.extend(["--expected-profile-revision",self.profile_revision])
        payload=json.dumps(body,ensure_ascii=False).encode() if body is not None else None
        # Do not forward provider keys or Node preload flags into the CLI process.
        completed=subprocess.run(args,input=payload,capture_output=True,timeout=65,env=dict(self._transport_env))
        if completed.returncode:
            code="INSTANCE_CLI_FAILED"
            try:
                error=json.loads(completed.stderr)
                candidate=error.get("repositoryCode") or error.get("error")
                if isinstance(candidate,str) and candidate.replace("_","").isalnum():
                    code=candidate
            except (ValueError,TypeError):
                pass
            raise InstanceStorageError("Repository command rejected: "+code)
        if self._owner_hash()!=self.owner_hash:
            raise InstanceStorageError("Storage owner changed; restart required")
        try:
            return json.loads(completed.stdout)
        except (ValueError,TypeError) as error:
            raise InstanceStorageError("Invalid repository transport response") from error

    def project_action(self,body):
        if self.execution_protocol != "REVIEW_CONTROLLED_ACTIONS_V1":
            raise InstanceStorageError("Owner runtime does not support controlled project actions")
        return self._command("assistant-action", [], body=body)

    def binding(self,path:Path):
        path=Path(os.path.abspath(path))
        for root,namespace in ((self.public_root,"assistant-public"),(self.private_root,"assistant-private")):
            if path.is_relative_to(root):
                key=path.relative_to(root).as_posix()
                if path.name=="model_catalog.json" or not path.name.endswith(".json"):
                    return None
                if ".." in Path(key).parts:
                    raise InstanceStorageError("Invalid auxiliary key")
                return namespace,key
        return None

    def get(self,path:Path):
        binding=self.binding(path)
        if not binding:
            raise InstanceStorageError("Path is not an auxiliary record")
        record=self._command("aux-get",["--namespace",binding[0],"--key",binding[1]])
        if record is None:
            return None
        try:
            content=base64.b64decode(record["bytesBase64"],validate=True)
        except (ValueError,KeyError) as error:
            raise InstanceStorageError("Invalid auxiliary bytes") from error
        if hashlib.sha256(content).hexdigest()!=record.get("sha256"):
            raise InstanceStorageError("Auxiliary bytes do not match their registered SHA")
        return {"namespace":binding[0],"record_key":record["key"],"revision_id":record["revisionId"],"revision_number":record["revision"],"previous_revision_id":record.get("previousRevisionId"),"content_bytes":content,"content_sha256":record["sha256"],"media_type":record["mediaType"],"metadata_json":json.dumps(record.get("metadata",{}),ensure_ascii=False),"deleted":record["deleted"],"created_at":record["createdAt"]}

    def read(self,path:Path,maximum:int):
        row=self.get(path)
        if not row or row["deleted"]:
            raise FileNotFoundError(path.name)
        if len(row["content_bytes"])>maximum:
            raise InstanceStorageError("Auxiliary record exceeds byte limit")
        return row["content_bytes"]

    def exists(self,path:Path):
        row=self.get(path)
        return bool(row and not row["deleted"])

    def heads(self,directory:Path,pattern:str):
        """Exact directory head identities only; never cache claim or mutation reads."""
        result={}
        for root,namespace in ((self.public_root,"assistant-public"),(self.private_root,"assistant-private")):
            if directory.is_relative_to(root):
                prefix=directory.relative_to(root).as_posix().strip(".")
                prefix=prefix.rstrip("/")+"/" if prefix else ""
                rows=self._command("aux-list",["--namespace",namespace,"--prefix",prefix,"--keys-only","true"])
                for row in rows:
                    key=row["key"]
                    suffix=key[len(prefix):] if key.startswith(prefix) else None
                    if suffix and "/" not in suffix and fnmatch.fnmatchcase(suffix,pattern):
                        revision=row.get("revisionId")
                        if not isinstance(revision,str) or not revision:
                            raise InstanceStorageError("Auxiliary directory lacks a head revision")
                        result[root/key]=revision
                return result
        return {path:None for path in directory.glob(pattern)}

    def glob(self,directory:Path,pattern:str):
        return list(self.heads(directory,pattern))

    def put(self,path:Path,content:bytes,exclusive=False):
        namespace,key=self.binding(path)
        row=self.get(path)
        if exclusive and row and not row["deleted"]:
            return False
        expected=row["revision_id"] if row else "NULL"
        self._command("aux-put",["--namespace",namespace,"--key",key,"--expected-revision",expected],{"bytesBase64":base64.b64encode(content).decode(),"mediaType":"application/json","metadata":{"authority":"HOST_PROTOCOL_RECORD","private":namespace=="assistant-private","runtimeEpoch":self.runtime_epoch}})
        return True

    def move(self,source:Path,destination:Path):
        source_ns,source_key=self.binding(source)
        destination_ns,destination_key=self.binding(destination)
        row=self.get(source)
        if not row or row["deleted"]:
            raise FileNotFoundError(source.name)
        self._command("aux-move",["--from-namespace",source_ns,"--from-key",source_key,"--from-revision",row["revision_id"],"--to-namespace",destination_ns,"--to-key",destination_key])
        return row["content_bytes"]

    def context(self,names):
        result=self._command("host-context",["--aliases",json.dumps(list(names),ensure_ascii=False)],bind_profile=True)
        documents=result["documents"];manifest=result["manifest"]
        for item in manifest:
            if item["path"]=="instance:current-release":
                continue
            content=documents[item["path"]].encode("utf-8")
            if len(content)!=item["bytes"] or hashlib.sha256(content).hexdigest()!=item["sha256"]:
                raise InstanceStorageError("Context document differs from its registered bytes")
        return manifest,documents,result["snapshot"]["snapshotId"]

    def source_chunk(self,catalog_hash:str,resource_id:str):
        return self._command("assistant-source-read",["--catalog-hash",catalog_hash,"--resource-id",resource_id])

    def search_sources(self,catalog_hash:str,query:str):
        return self._command("assistant-source-search",["--catalog-hash",catalog_hash,"--query",query])

    def media_bytes(self,alias:str,sha256:str,version_id=None,maximum=20*1024*1024):
        if not isinstance(maximum,int) or not 0 < maximum <= 20*1024*1024:
            raise InstanceStorageError("Invalid image byte limit")
        flags=["--alias",alias,"--sha256",sha256,"--include-bytes","true","--max-bytes",str(maximum)]
        if version_id:
            flags.extend(["--version-id",version_id])
        result=self._command("media-resolve",flags)
        record=result.get("media",{})
        try:
            content=base64.b64decode(result["bytesBase64"],validate=True)
        except (ValueError,KeyError,TypeError) as error:
            raise InstanceStorageError("Invalid registered media bytes") from error
        if record.get("sha256")!=sha256 or (version_id and record.get("versionId")!=version_id) or len(content)>maximum or len(content)!=record.get("byteSize") or hashlib.sha256(content).hexdigest()!=sha256:
            raise InstanceStorageError("Registered media bytes mismatch")
        return content

    def media(self,alias:str,sha256:str,version_id=None):
        flags=["--alias",alias,"--sha256",sha256]
        if version_id:
            flags.extend(["--version-id",version_id])
        record=self._command("media-resolve",flags)["media"]
        if record.get("sha256")!=sha256 or (version_id and record.get("versionId")!=version_id):
            raise InstanceStorageError("Registered media identity mismatch")
        relative=Path(record["relativePath"])
        if relative.is_absolute() or ".." in relative.parts or relative.parts[:1]!=("media",):
            raise InstanceStorageError("Registered media path escapes instance media")
        return self.root,relative

INSTANCE=InstanceStorage(Path(os.environ["REVIEW_INSTANCE_ROOT"])) if os.environ.get("REVIEW_INSTANCE_ROOT") else None

def aux_binding(path):
    return INSTANCE.binding(path) if INSTANCE else None

def path_exists(path):
    return INSTANCE.exists(path) if aux_binding(path) else path.exists()

def path_glob(directory,pattern):
    return INSTANCE.glob(directory,pattern) if INSTANCE else list(directory.glob(pattern))

"""Frozen, project-scoped context and three read-only tools for the review assistant.

This module does not call a model. Resource text is read only from a content-addressed
catalog; image bytes are read only from registered project production assets.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import zlib
from typing import Any, Callable
from instance_aux import INSTANCE, InstanceStorageError, aux_binding

PROTOCOL = "REVIEW_WORK_CONTEXT_V1"
SHA_RE = re.compile(r"^[a-f0-9]{64}$")
MAX_CATALOG_BYTES = 48 * 1024 * 1024
MAX_PACKET_BYTES = 1024 * 1024
MAX_TEXT_CHARS = 120_000
MAX_TOOL_CALLS = 16
MAX_READ_RESOURCES = 100
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_TOTAL_IMAGE_BYTES = 40 * 1024 * 1024
MAX_IMAGES = 4
TOOL_NAMESPACE = "review_context"


class ContextError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def bounded_text(value: Any, label: str, maximum: int = 500, *, empty: bool = False) -> str:
    if not isinstance(value, str) or (not empty and not value.strip()) or len(value) > maximum:
        raise ContextError("CONTEXT_INVALID", f"{label}无效")
    if any(0xD800 <= ord(c) <= 0xDFFF for c in value):
        raise ContextError("CONTEXT_INVALID", f"{label}含无效Unicode")
    return value


def sha(value: Any, label: str) -> str:
    if not isinstance(value, str) or not SHA_RE.fullmatch(value):
        raise ContextError("CONTEXT_INVALID", f"{label}不是完整SHA-256")
    return value


def read_regular(path: Path, maximum: int) -> bytes:
    if aux_binding(path):
        try:
            return INSTANCE.read(path, maximum)
        except (InstanceStorageError, OSError) as error:
            raise ContextError("CONTEXT_FILE_UNAVAILABLE", "实例上下文不能安全读取") from error
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
                raise ContextError("CONTEXT_FILE_INVALID", "上下文文件类型或大小无效")
            chunks = []
            size = 0
            while True:
                chunk = os.read(descriptor, min(1024 * 1024, maximum + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > maximum:
                    raise ContextError("CONTEXT_FILE_INVALID", "上下文文件超出读取上限")
            return b"".join(chunks)
        finally:
            os.close(descriptor)
    except OSError as error:
        raise ContextError("CONTEXT_FILE_UNAVAILABLE", "上下文文件不能安全读取") from error


def read_asset(root: Path, relative: Path, maximum: int) -> bytes:
    """Use directory descriptors so a renamed parent cannot redirect the read."""
    descriptors: list[int] = []
    try:
        directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptors.append(os.open(root, directory_flags))
        for component in relative.parts[:-1]:
            descriptors.append(os.open(component, directory_flags, dir_fd=descriptors[-1]))
        descriptor = os.open(relative.name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=descriptors[-1])
        descriptors.append(descriptor)
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
            raise ContextError("CONTEXT_FILE_INVALID", "媒体必须是有界普通文件")
        content = bytearray()
        while len(content) <= maximum:
            chunk = os.read(descriptor, min(1024 * 1024, maximum + 1 - len(content)))
            if not chunk:
                return bytes(content)
            content.extend(chunk)
        raise ContextError("CONTEXT_FILE_INVALID", "媒体超过允许大小")
    except OSError as error:
        raise ContextError("CONTEXT_FILE_INVALID", "媒体路径包含不可读取目录、符号链接或非普通文件") from error
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def read_json(path: Path, maximum: int) -> dict[str, Any]:
    try:
        value = json.loads(read_regular(path, maximum), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        canonical_json(value).encode("utf-8")
    except (ValueError, UnicodeError) as error:
        raise ContextError("CONTEXT_INVALID", "上下文不是有效JSON") from error
    if not isinstance(value, dict):
        raise ContextError("CONTEXT_INVALID", "上下文必须为JSON对象")
    return value


def check_directory(path: Path) -> None:
    if INSTANCE and path.is_relative_to(INSTANCE.public_root):
        return  # Namespace existence is established by the SQLite repository.
    try:
        if not stat.S_ISDIR(path.lstat().st_mode) or path.is_symlink():
            raise ContextError("CONTEXT_FILE_INVALID", "上下文目录不可为符号链接")
    except OSError as error:
        raise ContextError("CONTEXT_FILE_UNAVAILABLE", "上下文目录不可用") from error


def validate_reference(value: Any) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != {"packetId", "packetHash"}:
        raise ContextError("CONTEXT_INVALID", "assistantContext字段无效")
    packet_hash = sha(value["packetHash"], "packetHash")
    if value["packetId"] != "ctx_" + packet_hash:
        raise ContextError("CONTEXT_HASH_MISMATCH", "上下文ID与哈希不一致")
    return value


def image_dimensions(content: bytes, mime: str) -> tuple[int, int]:
    if mime == "image/png" and content.startswith(b"\x89PNG\r\n\x1a\n") and len(content) >= 24:
        offset = 8
        ended = False
        while offset + 12 <= len(content):
            size = int.from_bytes(content[offset:offset + 4], "big")
            if offset + 12 + size > len(content):
                raise ContextError("IMAGE_INVALID", "PNG数据块长度无效")
            kind_and_data = content[offset + 4:offset + 8 + size]
            if zlib.crc32(kind_and_data) != int.from_bytes(content[offset + 8 + size:offset + 12 + size], "big"):
                raise ContextError("IMAGE_INVALID", "PNG数据块完整性校验失败")
            offset += size + 12
            if kind_and_data[:4] == b"IEND":
                ended = offset == len(content)
                break
        if not ended:
            raise ContextError("IMAGE_INVALID", "PNG文件不完整")
        return struct.unpack(">II", content[16:24])
    if mime == "image/jpeg" and content.startswith(b"\xff\xd8"):
        index = 2
        while index + 4 <= len(content):
            if content[index] != 255:
                break
            while index < len(content) and content[index] == 255:
                index += 1
            if index >= len(content):
                break
            marker = content[index]
            index += 1
            if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
                continue
            if index + 2 > len(content):
                break
            length = int.from_bytes(content[index:index + 2], "big")
            if length < 2 or index + length > len(content):
                break
            if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF} and length >= 7:
                height, width = struct.unpack(">HH", content[index + 3:index + 7])
                return width, height
            index += length
    if mime == "image/webp" and len(content) >= 30 and content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        kind = content[12:16]
        if kind == b"VP8X":
            return (int.from_bytes(content[24:27], "little") + 1, int.from_bytes(content[27:30], "little") + 1)
        if kind == b"VP8 " and content[23:26] == b"\x9d\x01\x2a":
            return (int.from_bytes(content[26:28], "little") & 0x3FFF, int.from_bytes(content[28:30], "little") & 0x3FFF)
        if kind == b"VP8L" and content[20] == 0x2F:
            bits = int.from_bytes(content[21:25], "little")
            return ((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1)
    raise ContextError("IMAGE_INVALID", "图片格式、MIME或尺寸头无效")


def tool_specs() -> list[dict[str, Any]]:
    def function(name: str, description: str, properties: dict[str, Any], required: list[str]):
        return {"type": "function", "name": name, "description": description,
                "inputSchema": {"type": "object", "additionalProperties": False,
                                "properties": properties, "required": required}}
    return [{"type": "namespace", "name": TOOL_NAMESPACE,
             "description": "按本轮冻结目录只读查阅当前项目；不可访问项目外路径、网络或执行操作。",
             "tools": [
                 function("search_project", "搜索当前和参考资料，仅返回资源标识与元数据；正文须用read_resources读取，历史资源须显式指定ID。",
                          {"query": {"type": "string", "maxLength": 240}, "limit": {"type": "integer", "minimum": 1, "maximum": 8}, "cursor": {"type":"string","maxLength":100}}, ["query"]),
                 function("read_resources", "读取已登记资源正文；引用回答证据前必须实际读取资源。",
                          {"resourceIds": {"type": "array", "minItems": 1, "maxItems": 8, "items": {"type": "string"}}}, ["resourceIds"]),
                 function("view_image", "按资源与版本读取已登记图片原件；音频和视频不支持直接观察。",
                          {"resourceId": {"type": "string"}}, ["resourceId"]),
             ]}]


class WorkContext:
    def __init__(self, project_root: Path, store_root: Path, turn: dict[str, Any], progress: Callable[[str, str], None] | None = None, *, project_id: str = "REVIEW_FIXTURE"):
        self.project_root = project_root
        self.instance = INSTANCE if INSTANCE and project_root == INSTANCE.root else None
        scope_key = self.instance.profile["assistant"]["scopeKey"] if self.instance else "local:" + project_id
        self.store_root = store_root
        self.turn = turn
        self.reference = validate_reference(turn.get("assistantContext"))
        self.progress = progress or (lambda _phase, _message: None)
        for name in ("contexts", "catalogs"):
            check_directory(store_root / name)
        packet = read_json(store_root / "contexts" / (self.reference["packetId"] + ".json"), MAX_PACKET_BYTES)
        if set(packet) != {"packetId", "packetHash", "body"} or packet.get("packetId") != self.reference["packetId"] or packet.get("packetHash") != self.reference["packetHash"]:
            raise ContextError("CONTEXT_BINDING_INVALID", "上下文包引用不一致")
        body = packet.get("body")
        fields = {"schemaVersion", "projectId", "scopeKey", "snapshotId", "focus", "focusKey", "dependencyHash", "catalogHash", "initialResourceIds", "draftTargets", "missing"}
        if not isinstance(body, dict) or set(body) != fields or digest(body) != self.reference["packetHash"]:
            raise ContextError("CONTEXT_HASH_MISMATCH", "上下文包内容或哈希无效")
        if body.get("schemaVersion") not in {"1.0","1.1","1.2"} or body.get("projectId") != project_id or body.get("scopeKey") != scope_key or body.get("snapshotId") != turn.get("snapshotId"):
            raise ContextError("CONTEXT_SCOPE_INVALID", "上下文包项目、权限或快照不一致")
        self.body = body
        bounded_text(body["focusKey"], "focusKey", 1000)
        sha(body["dependencyHash"], "dependencyHash")
        catalog_hash = sha(body["catalogHash"], "catalogHash")
        if not isinstance(body["focus"], dict):
            raise ContextError("CONTEXT_INVALID", "工作位置无效")
        self.catalog = read_json(store_root / "catalogs" / (catalog_hash + ".json"), MAX_CATALOG_BYTES)
        if set(self.catalog) != {"schemaVersion", "projectId", "scopeKey", "snapshotId", "resources"} or digest(self.catalog) != catalog_hash:
            raise ContextError("CATALOG_HASH_MISMATCH", "资料目录哈希不一致")
        if any(self.catalog.get(key) != body[key] for key in ("schemaVersion", "projectId", "scopeKey", "snapshotId")):
            raise ContextError("CONTEXT_SCOPE_INVALID", "资料目录权限或快照不一致")
        resources = self.catalog.get("resources")
        if not isinstance(resources, list) or len(resources) > 10_000:
            raise ContextError("CONTEXT_INVALID", "资料目录数量无效")
        self.resources: dict[str, dict[str, Any]] = {}
        for resource in resources:
            self._validate_resource(resource)
            if resource["id"] in self.resources:
                raise ContextError("CONTEXT_INVALID", "资料目录包含重复资源")
            self.resources[resource["id"]] = resource
        initial = body["initialResourceIds"]
        if not isinstance(initial, list) or len(initial) > 48 or any(not isinstance(key, str) for key in initial):
            raise ContextError("CONTEXT_INVALID", "当前工作资料引用无效")
        for key in initial:
            self._resource(key)
        self.targets: dict[str, dict[str, Any]] = {}
        if not isinstance(body["draftTargets"], list) or len(body["draftTargets"]) > 30:
            raise ContextError("CONTEXT_INVALID", "草稿目标无效")
        for target in body["draftTargets"]:
            required = {"id", "label", "fieldId", "subjectId", "value", "baseHash"}
            if not isinstance(target, dict) or not required.issubset(target) or set(target) - required - {"versionId"}:
                raise ContextError("CONTEXT_INVALID", "草稿目标字段无效")
            for key in ("id", "label", "fieldId", "subjectId"):
                bounded_text(target[key], key, 4096 if key == "id" else 500)
            if any(ord(character) < 32 or ord(character) == 127 for character in target["id"]):
                raise ContextError("CONTEXT_INVALID", "草稿目标ID含控制字符")
            bounded_text(target["value"], "草稿正文", 30_000, empty=True)
            sha(target["baseHash"], "baseHash")
            if target["id"] in self.targets:
                raise ContextError("CONTEXT_INVALID", "草稿目标重复")
            self.targets[target["id"]] = target
        if not isinstance(body["missing"], list) or len(body["missing"]) > 100:
            raise ContextError("CONTEXT_INVALID", "上下文缺项无效")
        for missing in body["missing"]:
            bounded_text(missing, "缺项", 2000)
        self.read_ids: set[str] = set()
        self.image_ids: set[str] = set()
        self.text_chars = 0
        self.image_bytes = 0
        self.tool_calls = 0
        self.replays: dict[str, tuple[str, dict[str, Any]]] = {}
        self.source_reads: dict[str, dict[str, Any]] = {}

    def _validate_resource(self, resource: Any) -> None:
        required = {"id", "title", "kind", "sha256", "text", "href", "role", "relations"}
        if not isinstance(resource, dict) or not required.issubset(resource) or set(resource) - required - {"versionId", "media", "sourceBinding", "bodyBinding", "relationBinding"}:
            raise ContextError("CONTEXT_INVALID", "资源字段无效")
        for key in ("id", "title", "kind"):
            bounded_text(resource[key], key, 1000)
        text = bounded_text(resource["text"], "资源正文", 500_000, empty=True)
        text_hash = sha(resource["sha256"], "资源sha256")
        if hashlib.sha256(text.encode("utf-8")).hexdigest() != text_hash:
            raise ContextError("RESOURCE_HASH_MISMATCH", "资源正文与SHA-256不一致")
        href = bounded_text(resource["href"], "资源链接", 2000, empty=True)
        if href and (not href.startswith(("/", "?", "#")) or href.startswith("//") or "\\" in href):
            raise ContextError("CONTEXT_INVALID", "资源链接必须是审阅台内部链接")
        if resource["role"] not in {"CURRENT", "HISTORICAL", "REFERENCE"}:
            raise ContextError("CONTEXT_INVALID", "资源角色无效")
        if not isinstance(resource["relations"], list) or len(resource["relations"]) > (10000 if self.body["schemaVersion"] == "1.2" else 500) or any(not isinstance(x, str) for x in resource["relations"]):
            raise ContextError("CONTEXT_INVALID", "资源关系无效")
        binding = resource.get("sourceBinding")
        if binding is not None:
            expected = {"schemaVersion","releaseId","documentId","revisionId","sha256","byteSize","byteStart","byteEnd"}
            if self.body["schemaVersion"] not in {"1.1","1.2"} or not isinstance(binding,dict) or set(binding) != expected:
                raise ContextError("CONTEXT_INVALID","来源分块绑定无效")
            if binding["schemaVersion"] != "1.0" or resource.get("versionId") != binding["revisionId"]:
                raise ContextError("CONTEXT_INVALID","来源修订不一致")
            for key in ("releaseId","documentId","revisionId"):
                bounded_text(binding[key],key,2048)
            sha(binding["sha256"],"source sha256")
            if any(isinstance(binding[k],bool) or not isinstance(binding[k],int) or binding[k]<0 for k in ("byteSize","byteStart","byteEnd")) or not 0 <= binding["byteStart"] <= binding["byteEnd"] <= binding["byteSize"] or binding["byteEnd"]-binding["byteStart"]>12000:
                raise ContextError("CONTEXT_INVALID","来源字节范围无效")
            try:
                same = json.loads(text).get("sourceBinding") == binding
            except (ValueError,AttributeError):
                same = False
            if not same:
                raise ContextError("CONTEXT_INVALID","来源目录与精确绑定不一致")
        for key in ("bodyBinding","relationBinding"):
            binding=resource.get(key)
            if binding is None:
                continue
            if self.body["schemaVersion"]!="1.2" or resource.get("sourceBinding") or (key=="relationBinding" and (not resource.get("bodyBinding") or resource["relations"])):
                raise ContextError("CONTEXT_INVALID","业务正文索引不一致")
            self._validate_body_binding(binding)
            try:
                same=json.loads(text).get(key)==binding
            except (ValueError,AttributeError):
                same=False
            if not same:
                raise ContextError("CONTEXT_INVALID","业务正文目录与绑定不一致")
        media = resource.get("media")
        if media is not None:
            if not isinstance(media, dict) or set(media) != {"kind", "path", "sha256", "mimeType"} or media["kind"] not in {"image", "audio", "video"}:
                raise ContextError("CONTEXT_INVALID", "媒体绑定无效")
            for key in ("path", "mimeType"):
                bounded_text(media[key], key, 2000)
            sha(media["sha256"], "媒体sha256")

    @staticmethod
    def _validate_body_binding(binding: Any) -> None:
        keys={"schemaVersion","sha256","byteSize","characterCount","chunkCount"}
        if not isinstance(binding,dict) or set(binding)!=keys or binding["schemaVersion"]!="1.0":
            raise ContextError("CONTEXT_INVALID","业务正文绑定无效")
        sha(binding["sha256"],"body SHA")
        if any(isinstance(binding[k],bool) or not isinstance(binding[k],int) or binding[k]<0 for k in ("byteSize","characterCount","chunkCount")) or binding["byteSize"]>32*1024*1024 or binding["characterCount"]>binding["byteSize"] or binding["chunkCount"]!=max(1,(binding["byteSize"]+11999)//12000):
            raise ContextError("CONTEXT_INVALID","业务正文大小无效")

    def _resource(self, resource_id: Any) -> dict[str, Any]:
        key=bounded_text(resource_id,"resourceId",1000)
        if key in self.resources:
            return self.resources[key]
        try:
            base_id,suffix=key.rsplit(":body:",1)
            body_sha,ordinal=suffix.split(":")
            base=self.resources[base_id]
            if self.body["schemaVersion"]!="1.2" or not re.fullmatch(r"\d{6}",ordinal):
                raise ValueError()
            section="TEXT" if base.get("bodyBinding",{}).get("sha256")==body_sha else "RELATIONS"
            binding=base.get("bodyBinding" if section=="TEXT" else "relationBinding")
            self._validate_body_binding(binding)
            index=int(ordinal)
            if binding["sha256"]!=body_sha or index>=binding["chunkCount"]:
                raise ValueError()
            chunk_id=lambda i:base_id+":body:"+body_sha+":"+str(i).zfill(6)
            byte_range={"byteStart":index*12000,"byteEnd":min((index+1)*12000,binding["byteSize"])}
            metadata={"resourceId":base_id,"bodySha256":body_sha,**byte_range,"byteSize":binding["byteSize"],"part":index+1,"parts":binding["chunkCount"],"previousResourceId":chunk_id(index-1) if index else None,"nextResourceId":chunk_id(index+1) if index+1<binding["chunkCount"] else None,"boundary":"本条元数据未包含正文；实际读取返回sourceText、sourceTextSha256和精确字节范围，不代表其他块已读。"}
            text=json.dumps(metadata,ensure_ascii=False,separators=(",",":"))
            return {**{k:v for k,v in base.items() if k not in {"media","relationBinding"}},"relations":[],"id":key,"title":base["title"]+" · 正文第"+str(index+1)+"/"+str(binding["chunkCount"])+"部分","text":text,"sha256":hashlib.sha256(text.encode()).hexdigest(),"bodyBinding":binding,"bodyRange":byte_range,"bodyOf":base_id,"bodySection":section}
        except (KeyError,ValueError,TypeError,ContextError) as error:
            raise ContextError("RESOURCE_UNAVAILABLE","资料不在本轮冻结目录的精确范围内") from error

    def _body_read(self,resource:dict[str,Any]) -> dict[str,Any]:
        if not resource.get("bodyRange"):
            return {}
        if resource["id"] in self.source_reads:
            return self.source_reads[resource["id"]]
        binding=resource["bodyBinding"]
        try:
            if self.instance:
                result=self.instance.source_chunk(self.body["catalogHash"],resource["id"])
            else:
                folder=self.store_root/"resource-bodies"
                check_directory(folder)
                content=read_regular(folder/(binding["sha256"]+".txt"),32*1024*1024)
                if len(content)!=binding["byteSize"] or hashlib.sha256(content).hexdigest()!=binding["sha256"] or len(content.decode("utf-8"))!=binding["characterCount"]:
                    raise ValueError("body bytes")
                start,end=resource["bodyRange"]["byteStart"],resource["bodyRange"]["byteEnd"]
                while start<len(content) and content[start]&0xc0==0x80:
                    start+=1
                while end<len(content) and content[end]&0xc0==0x80:
                    end+=1
                part=content[start:end]
                result={"resourceId":resource["id"],"bodyOf":resource["bodyOf"],"bodySection":resource["bodySection"],"bodySha256":binding["sha256"],"sourceText":part.decode("utf-8"),"sourceTextSha256":hashlib.sha256(part).hexdigest(),"sourceSha256":binding["sha256"],"revisionId":resource.get("versionId") or binding["sha256"],"byteStart":start,"byteEnd":end,"byteSize":len(content),"wholeBodyRead":start==0 and end==len(content)}
        except (InstanceStorageError,OSError,ValueError) as error:
            raise ContextError("RESOURCE_SCOPE_INVALID","业务正文未通过冻结目录和SHA核验") from error
        text=bounded_text(result.get("sourceText"),"业务正文分块",16000,empty=True)
        start,end=result.get("byteStart"),result.get("byteEnd")
        nominal=resource["bodyRange"]
        if any(isinstance(n,bool) or not isinstance(n,int) for n in (start,end)) or not nominal["byteStart"]<=start<=min(binding["byteSize"],nominal["byteStart"]+3) or not nominal["byteEnd"]<=end<=min(binding["byteSize"],nominal["byteEnd"]+3) or result.get("resourceId")!=resource["id"] or result.get("bodyOf")!=resource["bodyOf"] or result.get("bodySection")!=resource["bodySection"] or result.get("bodySha256")!=binding["sha256"] or result.get("sourceSha256")!=binding["sha256"] or result.get("revisionId")!=(resource.get("versionId") or binding["sha256"]) or result.get("byteSize")!=binding["byteSize"] or hashlib.sha256(text.encode()).hexdigest()!=result.get("sourceTextSha256") or len(text.encode())!=end-start or result.get("wholeBodyRead")!=(start==0 and end==binding["byteSize"]):
            raise ContextError("RESOURCE_HASH_MISMATCH","业务正文分块范围、角色来源或SHA不一致")
        if len(canonical_json({**resource,**result}))>80000:
            raise ContextError("CONTEXT_BUDGET_EXCEEDED","业务正文分块超出读取预算")
        self.source_reads[resource["id"]]=result
        return result

    def _source_read(self,resource:dict[str,Any]) -> dict[str,Any]:
        if resource.get("bodyRange"):
            return self._body_read(resource)
        if not resource.get("sourceBinding"):
            return {}
        if resource["id"] in self.source_reads:
            return self.source_reads[resource["id"]]
        if not self.instance:
            raise ContextError("SOURCE_STORAGE_UNAVAILABLE","来源分块需要已绑定的实例存储")
        try:
            result = self.instance.source_chunk(self.body["catalogHash"],resource["id"])
        except InstanceStorageError as error:
            raise ContextError("RESOURCE_SCOPE_INVALID","来源分块未能通过实例版本与SHA校验") from error
        binding=resource["sourceBinding"]
        text=bounded_text(result.get("sourceText"),"来源分块",16000,empty=True)
        if result.get("resourceId") != resource["id"] or result.get("revisionId") != binding["revisionId"] or result.get("sourceSha256") != binding["sha256"] or result.get("byteSize") != binding["byteSize"] or not binding["byteStart"] <= result.get("byteStart",-1) <= binding["byteStart"]+3 or not binding["byteEnd"] <= result.get("byteEnd",-1) <= min(binding["byteSize"],binding["byteEnd"]+3) or hashlib.sha256(text.encode("utf-8")).hexdigest() != result.get("sourceTextSha256") or len(text.encode("utf-8")) != result["byteEnd"]-result["byteStart"]:
            raise ContextError("RESOURCE_HASH_MISMATCH","来源分块内容或字节范围不一致")
        if len(canonical_json({**resource,**result}))>80000:
            raise ContextError("CONTEXT_BUDGET_EXCEEDED","来源分块序列化超出单次读取预算")
        self.source_reads[resource["id"]]=result
        return result

    def read_resources(self, resource_ids: Any) -> dict[str, Any]:
        if not isinstance(resource_ids, list) or not 1 <= len(resource_ids) <= 48:
            raise ContextError("INVALID_ARGUMENTS", "请指定有效资料列表")
        resources_by_id = {item["id"]: item for item in (self._resource(key) for key in resource_ids)}
        resources = list(resources_by_id.values())
        if len(self.read_ids | resources_by_id.keys()) > MAX_READ_RESOURCES:
            raise ContextError("RESOURCE_BUDGET_EXCEEDED", "本轮实际读取资料已达100项上限；请缩小问题范围")
        source_contents = {item["id"]:self._source_read(item) for item in resources}
        new_chars = sum((len(canonical_json(item))+len(canonical_json(source_contents[item["id"]]))+256) if self.body["schemaVersion"]=="1.2" else len(item["text"])+len(source_contents[item["id"]].get("sourceText","")) for item in resources if item["id"] not in self.read_ids)
        if self.text_chars + new_chars > MAX_TEXT_CHARS:
            raise ContextError("CONTEXT_BUDGET_EXCEEDED", "本轮全文读取已达上限；请缩小问题范围")
        self.text_chars += new_chars
        self.read_ids.update(item["id"] for item in resources)
        return {"resources": [{key: value for key, value in item.items() if key != "media"} | source_contents[item["id"]] | {
            **({"bodyState": "INDEX_ONLY_BODY_NOT_READ" if not item.get("bodyRange") else "BODY_CHUNK_READ",
                "wholeBodyRead": source_contents[item["id"]].get("wholeBodyRead",False)} if item.get("bodyBinding") else {}),
            "observation": "IMAGE_AVAILABLE_NOT_OBSERVED" if item.get("media", {}).get("kind") == "image" else "SOURCE_CHUNK_READ" if item.get("sourceBinding") else "TEXT_OR_METADATA_ONLY"
        } for item in resources],"remainingCharacters":MAX_TEXT_CHARS-self.text_chars,"readResourceCount":len(self.read_ids)}

    def initial_prompt(self, history: list[dict[str, str]]) -> str:
        self.progress("READING_CONTEXT", "正在读取当前工作资料")
        initial = self.read_resources(self.body["initialResourceIds"]) if self.body["initialResourceIds"] else {"resources": []}
        if self.body["schemaVersion"]=="1.2" and len(canonical_json(initial["resources"]))>72000:
            raise ContextError("CONTEXT_BUDGET_EXCEEDED","初始精确资料超过72000字符；索引不代表正文，需减少附加块后按需读取")
        return canonical_json({
            "protocol": PROTOCOL, "projectId": self.body["projectId"], "focus": self.body["focus"],
            "focusKey": self.body["focusKey"], "snapshotId": self.body["snapshotId"],
            "packetHash": self.reference["packetHash"], "currentResources": initial["resources"],
            "draftTargets": list(self.targets.values()), "missing": self.body["missing"],
            "historicalDiscussionNotCurrentEvidence": history,
            "userQuestion": self.turn["userMessage"],
        })

    def search(self, query: Any, limit: Any = 5, cursor: Any = None) -> dict[str, Any]:
        query = bounded_text(query, "query", 240).strip().lower()
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 8:
            raise ContextError("INVALID_ARGUMENTS", "搜索数量必须在1到8之间")
        terms = re.findall(r"[a-z0-9_-]+|[\u3400-\u9fff]+", query)
        terms = terms[:20] or [query]
        ranked = []
        for resource in self.resources.values():
            if resource["role"] == "HISTORICAL" or resource.get("sourceBinding") or resource.get("bodyBinding"):
                continue
            title = resource["title"].lower()
            text = resource["text"].lower()
            score = sum(8 * (term in title) + 2 * (term in resource["id"].lower()) + (term in text) for term in terms)
            if not score:
                pairs = [query[index:index + 2] for index in range(len(query) - 1) if all("\u3400" <= c <= "\u9fff" for c in query[index:index + 2])]
                score = sum(2 * (term in title) + (term in text) for term in pairs[:30]) / 100
            if score:
                ranked.append((score, resource))
        if any(resource.get("sourceBinding") or resource.get("bodyBinding") for resource in self.resources.values()):
            if not self.instance:
                raise ContextError("SOURCE_STORAGE_UNAVAILABLE","来源检索需要已绑定的实例存储")
            try:
                source_matches=self.instance.search_sources(self.body["catalogHash"],query)["matches"]
            except (InstanceStorageError,KeyError,TypeError) as error:
                raise ContextError("RESOURCE_SCOPE_INVALID","来源检索未能验证冻结目录") from error
            for match in source_matches:
                resource=self._resource(match.get("id"))
                if not (resource.get("sourceBinding") or resource.get("bodyRange")) or resource["role"]=="HISTORICAL" or not isinstance(match.get("score"),(int,float)) or match["score"]<=0:
                    raise ContextError("RESOURCE_SCOPE_INVALID","来源检索结果不属于冻结目录")
                ranked.append((match["score"],resource))
        ranked.sort(key=lambda item: (-item[0], item[1]["id"]))
        prefix=digest({"catalogHash":self.body["catalogHash"],"query":query})+":"
        offset=0
        if cursor is not None:
            value=bounded_text(cursor,"cursor",100)
            if not value.startswith(prefix) or not value[len(prefix):].isdigit():
                raise ContextError("INVALID_ARGUMENTS","检索游标与当前目录或问题不匹配")
            offset=int(value[len(prefix):])
            if offset>len(ranked):
                raise ContextError("INVALID_ARGUMENTS","检索游标越界")
        next_offset=offset+limit
        return {"matches": [{"id": r["id"], "title": r["title"], "kind": r["kind"], "role": r["role"], "sha256": r["sha256"], "characterCount": len(r["text"]), **({"bodyDeferred":True} if r.get("sourceBinding") or r.get("bodyBinding") else {})} for _, r in ranked[offset:next_offset]], "totalMatches": len(ranked), "fullTextRead": False, "nextCursor":prefix+str(next_offset) if next_offset<len(ranked) else None}

    def view_image(self, resource_id: Any) -> dict[str, Any]:
        resource = self._resource(resource_id)
        media = resource.get("media")
        if not media or media["kind"] != "image":
            raise ContextError("MODALITY_UNAVAILABLE", "该资源不是可直接观察的图片；声音与视频当前只读文字资料")
        if resource["id"] not in self.read_ids and len(self.read_ids) >= MAX_READ_RESOURCES:
            raise ContextError("RESOURCE_BUDGET_EXCEEDED", "本轮实际读取资料已达100项上限；请缩小问题范围")
        if self.instance:
            try:
                content = self.instance.media_bytes(media["path"], media["sha256"], resource.get("versionId"), MAX_IMAGE_BYTES)
            except InstanceStorageError as error:
                raise ContextError("RESOURCE_SCOPE_INVALID", "图片缺少当前实例精确版本与SHA绑定") from error
        else:
            root, relative = self.project_root, Path(media["path"])
            if relative.is_absolute() or ".." in relative.parts or relative.parts[:2] != ("production", "generated"):
                raise ContextError("RESOURCE_SCOPE_INVALID", "媒体不在允许的项目素材范围内")
            content = read_asset(root, relative, MAX_IMAGE_BYTES)
        if hashlib.sha256(content).hexdigest() != media["sha256"]:
            raise ContextError("RESOURCE_HASH_MISMATCH", "图片原件与登记SHA-256不一致")
        width, height = image_dimensions(content, media["mimeType"])
        if width <= 0 or height <= 0 or max(width, height) > 16_384 or width * height > 100_000_000:
            raise ContextError("IMAGE_LIMIT_EXCEEDED", "图片尺寸超出允许范围")
        new_image = resource["id"] not in self.image_ids
        if new_image and (len(self.image_ids) >= MAX_IMAGES or self.image_bytes + len(content) > MAX_TOTAL_IMAGE_BYTES):
            raise ContextError("IMAGE_BUDGET_EXCEEDED", "本轮图片读取已达上限")
        if new_image:
            self.image_bytes += len(content)
        self.image_ids.add(resource["id"])
        self.read_ids.add(resource["id"])
        info = {"resourceId": resource["id"], "title": resource["title"], "versionId": resource.get("versionId"), "sha256": media["sha256"], "width": width, "height": height, "observation": "ORIGINAL_IMAGE_BYTES_PROVIDED"}
        return {"success": True, "contentItems": [
            {"type": "inputText", "text": canonical_json(info)},
            {"type": "inputImage", "imageUrl": f"data:{media['mimeType']};base64," + base64.b64encode(content).decode("ascii")},
        ]}

    def tool_call(self, params: dict[str, Any]) -> dict[str, Any]:
        call_id = bounded_text(params.get("callId"), "callId", 200)
        tool = params.get("tool")
        arguments = params.get("arguments")
        if params.get("namespace") != TOOL_NAMESPACE or tool not in {"search_project", "read_resources", "view_image"} or not isinstance(arguments, dict):
            raise ContextError("TOOL_NOT_ALLOWED", "该工具不在当前只读能力范围内")
        semantic_hash = digest({"tool": tool, "arguments": arguments})
        if call_id in self.replays:
            previous_hash, response = self.replays[call_id]
            if previous_hash != semantic_hash:
                raise ContextError("TOOL_CALL_CONFLICT", "重复工具调用的参数不一致")
            return response
        self.tool_calls += 1
        try:
            if self.tool_calls > MAX_TOOL_CALLS:
                raise ContextError("TOOL_BUDGET_EXCEEDED", "本轮按需查阅次数已达上限")
            if tool == "search_project":
                if set(arguments) - {"query", "limit", "cursor"} or "query" not in arguments:
                    raise ContextError("INVALID_ARGUMENTS", "搜索参数无效")
                self.progress("SEARCHING", "正在检索同项目资料")
                value = self.search(arguments["query"], arguments.get("limit", 5), arguments.get("cursor"))
            elif tool == "read_resources":
                if set(arguments) != {"resourceIds"} or not isinstance(arguments["resourceIds"], list) or len(arguments["resourceIds"]) > 8:
                    raise ContextError("INVALID_ARGUMENTS", "读取参数无效")
                self.progress("READING", "正在阅读相关资料")
                value = self.read_resources(arguments["resourceIds"])
            else:
                if set(arguments) != {"resourceId"}:
                    raise ContextError("INVALID_ARGUMENTS", "看图参数无效")
                self.progress("VIEWING_IMAGE", "正在查看已登记图片原件")
                response = self.view_image(arguments["resourceId"])
                self.replays[call_id] = (semantic_hash, response)
                return response
            response = {"success": True, "contentItems": [{"type": "inputText", "text": canonical_json(value)}]}
        except ContextError as error:
            if error.code in {"RESOURCE_SCOPE_INVALID", "RESOURCE_HASH_MISMATCH", "CONTEXT_FILE_INVALID"}:
                raise
            response = {"success": False, "contentItems": [{"type": "inputText", "text": canonical_json({"error": error.code, "message": str(error)})}]}
        self.replays[call_id] = (semantic_hash, response)
        return response

    def result_binding(self, evidence: list[dict[str, str]], suggestions: list[dict[str, str]]) -> dict[str, Any]:
        for item in evidence:
            if not item["path"].startswith("resource:") or item["path"][9:] not in self.read_ids:
                raise ContextError("EVIDENCE_NOT_READ", "回答引用了本轮未实际读取的资料")
        seen = set()
        for suggestion in suggestions:
            if not isinstance(suggestion, dict) or set(suggestion) != {"targetId", "text"} or not isinstance(suggestion["targetId"], str) or suggestion["targetId"] not in self.targets or suggestion["targetId"] in seen:
                raise ContextError("DRAFT_TARGET_INVALID", "建议草稿没有唯一绑定当前可采用字段")
            bounded_text(suggestion["text"], "建议正文", 20_000)
            seen.add(suggestion["targetId"])
        return {**self.reference, "focusKey": self.body["focusKey"], "evidenceIds": sorted(self.read_ids), "observedImageIds": sorted(self.image_ids), "suggestions": suggestions, "stale": False}

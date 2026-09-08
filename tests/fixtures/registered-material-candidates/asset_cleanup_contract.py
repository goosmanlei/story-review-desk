from __future__ import annotations
import hashlib,json,re
from pathlib import Path,PurePosixPath
from typing import Any
ROOT=Path(__file__).resolve().parents[1]
DEFAULT_REVIEW_EVENT_STORE=ROOT/"events"
MEDIA_SUFFIXES={".wav",".png"}

def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path}: root must be an object")
    return value

def normalize_project_path(value: str) -> str:
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError(f"unsafe project-relative path: {value!r}")
    return path.as_posix()

def resolve_project_path(root: Path, value: str) -> Path:
    normalized = normalize_project_path(value)
    resolved_root = root.resolve()
    resolved = (resolved_root / normalized).resolve()
    try:
        resolved.relative_to(resolved_root)
    except ValueError as error:
        raise ValueError(f"path escapes project root: {value!r}") from error
    return resolved

def file_fingerprint(root: Path, relative_path: str, expected_sha: str | None = None) -> dict:
    path = resolve_project_path(root, relative_path)
    if not path.is_file():
        return {
            "path": relative_path,
            "exists": False,
            "dev": None,
            "ino": None,
            "size": None,
            "mtimeMs": None,
            "sha256": expected_sha,
            "hashMatches": None,
        }
    stat = path.stat()
    actual_sha = sha256_file(path)
    return {
        "path": relative_path,
        "exists": True,
        "dev": stat.st_dev,
        "ino": stat.st_ino,
        "size": stat.st_size,
        "mtimeMs": stat.st_mtime_ns // 1_000_000,
        "sha256": actual_sha,
        "hashMatches": expected_sha is None or actual_sha == expected_sha,
    }

def registered_material_candidate_paths(
    material_registry: dict,
    *,
    event_store: Path = DEFAULT_REVIEW_EVENT_STORE,
    root: Path = ROOT,
    verify_files: bool = True,
) -> dict[str, dict]:
    """Return strictly verified candidate media registered by AssetVersionEvent.

    The append-only localhost event store is the authority.  A candidate may
    outlive the snapshot in which it was registered, so its event snapshot ID
    is provenance rather than a current-snapshot equality gate.
    """

    if material_registry.get("schema_version") != "1.1":
        raise ValueError("unsupported material requirements registry contract")
    planned_by_family = {
        str(requirement["planned_family_id"]): requirement
        for requirement in material_registry.get("requirements", [])
        if isinstance(requirement, dict)
        and requirement.get("planned_output_path")
        and requirement.get("planned_family_id")
    }
    registered: dict[str, dict] = {}
    registered_by_version: dict[str, dict] = {}
    event_ids: set[str] = set()
    if not event_store.is_dir():
        return registered
    for event_path in sorted(event_store.glob("asset-version-*.json")):
        event = load_json(event_path)
        filename_match = re.fullmatch(r"asset-version-([0-9a-f]{64})\.json", event_path.name)
        idempotency_hash = str(event.get("idempotencyKeyHash") or "").lower()
        event_id = str(event.get("eventId") or "")
        if (
            not filename_match
            or idempotency_hash != filename_match.group(1)
            or event.get("eventKind") != "asset-version"
            or event.get("schemaVersion") != "1.1"
            or not event_id
            or event_id in event_ids
        ):
            raise ValueError(f"{event_path}: invalid AssetVersionEvent identity/contract")
        event_ids.add(event_id)

        family_id = str(event.get("familyId") or "")
        if family_id not in planned_by_family:
            raise ValueError(f"{event_path}: AssetVersionEvent family is not a registered material plan")
        relative_path = normalize_project_path(str(event.get("path") or ""))
        if (
            not relative_path.startswith("production/generated/")
            or PurePosixPath(relative_path).suffix.lower() not in MEDIA_SUFFIXES
        ):
            raise ValueError(f"{event_path}: candidate path must be media under production/generated")
        version_id = str(event.get("versionId") or "")
        version_match = re.search(r"_(V\d{3})(?=\.[^.]+$)", relative_path)
        expected_output_id = f"EXPECTED_OUTPUT:{version_id}"
        digest = str(event.get("sha256") or "").lower()
        realizes = event.get("realizes") or {}
        fingerprint = file_fingerprint(root, relative_path, digest) if verify_files else None
        if (
            not version_match
            or version_id != f"{family_id}@{version_match.group(1)}"
            or event.get("expectedOutputId") != expected_output_id
            or event.get("plannedVersionId") != version_id
            or event.get("realizationRelation") != "REALIZES"
            or realizes.get("relationType") != "REALIZES"
            or realizes.get("expectedOutputId") != expected_output_id
            or realizes.get("assetVersionId") != version_id
            or not re.fullmatch(r"[0-9a-f]{64}", digest)
            or event.get("outputState") != "PRESENT"
            or event.get("historyRole") != "CANDIDATE"
            or event.get("lifecycleState") != "REVIEW_PENDING"
            or event.get("reviewDecision") != "PENDING"
            or event.get("registrationState")
            != "CANDIDATE_REGISTERED_EXPECTED_OUTPUT_REALIZED"
            or event.get("adoptionPerformed") is not False
            or not isinstance(event.get("byteSize"), int)
            or event.get("byteSize", 0) <= 0
            or (
                fingerprint is not None
                and (
                    not fingerprint["exists"]
                    or fingerprint["hashMatches"] is not True
                    or fingerprint["size"] != event.get("byteSize")
                )
            )
        ):
            raise ValueError(
                f"{event_path}: registered material candidate does not match its ExpectedOutput bytes"
            )
        try:
            event_source_ref = event_path.resolve().relative_to(root.resolve()).as_posix()
        except ValueError as error:
            raise ValueError(f"{event_path}: event store escapes project root") from error
        normalized = {
            "eventId": event_id,
            "eventSnapshotId": event.get("snapshotId"),
            "familyId": family_id,
            "versionId": version_id,
            "expectedOutputId": expected_output_id,
            "path": relative_path,
            "sha256": digest,
            "byteSize": event.get("byteSize"),
            "historyRole": "CANDIDATE",
            "lifecycleState": "REVIEW_PENDING",
            "sourceRef": event_source_ref,
            "sourceSha256": sha256_file(event_path),
            "file": fingerprint,
        }
        if relative_path in registered or version_id in registered_by_version:
            raise ValueError(f"{event_path}: duplicate candidate path/version claim")
        registered[relative_path] = normalized
        registered_by_version[version_id] = normalized
    return dict(sorted(registered.items()))

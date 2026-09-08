from __future__ import annotations
import hashlib,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
ordered_unique=lambda xs:list(dict.fromkeys(xs))
sha256=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def build_production_model(output):
    families={};versions={};expected_outputs={};exact_path_to_family={};episode_by_scene={};episode_uid_by_id={}
    def version_label(p):
        m=re.search(r"_(V\d{3})(?=\.[^.]+$)",p)
        return m.group(1) if m else "CURRENT"
    def add_family(
        family_id: str,
        *,
        label: str,
        kind: str,
        subtype: str,
        scene_ids: list[str] | None = None,
        shot_ids: list[str] | None = None,
        segment_ids: list[str] | None = None,
        source_ref: str,
        path: str | None = None,
        materialization: str = "PLANNED",
        execution: str = "NOT_STARTED",
        gate: str = "WAITING_DEPENDENCY",
        qa: str = "NOT_RUN",
        approval: str = "NOT_REVIEWED",
        rights: str = "UNKNOWN",
        eligibility: str = "WAITING",
        preview: str | None = None,
        audio_proxy: str | None = None,
        prompt_ref: str | None = None,
        model: str | None = None,
        sha_value: str | None = None,
        history_id: str | None = None,
        resource_id: str | None = None,
        asset_role: str | None = None,
        provenance: dict | None = None,
        explicit_version_id: str | None = None,
        preserve_expected_output: bool = False,
    ) -> str:
        scene_ids = ordered_unique(scene_ids or [])
        shot_ids = ordered_unique(shot_ids or [])
        segment_ids = ordered_unique(segment_ids or [])
        if family_id not in families:
            families[family_id] = {
                "id": family_id,
                "label": label,
                "kind": kind,
                "subtype": subtype,
                "episodeIds": ordered_unique([episode_by_scene[scene] for scene in scene_ids if scene in episode_by_scene]),
                "episodeUids": ordered_unique([episode_uid_by_id[episode_by_scene[scene]] for scene in scene_ids if scene in episode_by_scene]),
                "sceneIds": scene_ids,
                "segmentIds": segment_ids,
                "shotIds": shot_ids,
                "definitionStatus": "DEFINED",
                "materializationState": materialization,
                "executionState": execution,
                "gateStatus": gate,
                "qaStatus": qa,
                "approvalStatus": approval,
                "rightsStatus": rights,
                "downstreamEligibility": eligibility,
                "currentVersionId": None,
                "versionRefs": [],
                "currentExpectedOutputId": None,
                "expectedOutputRefs": [],
                "versionDeepLinkAliases": [],
                "ownerRef": "GLOBAL/UNKNOWN",
                "usedByRefs": [],
                "materialRequirementRefs": [],
                "sourceRef": source_ref,
            }
            if asset_role:
                families[family_id]["assetRole"] = asset_role
            if provenance:
                families[family_id]["provenance"] = dict(provenance)
        else:
            family = families[family_id]
            family["sceneIds"] = ordered_unique([*family["sceneIds"], *scene_ids])
            family["episodeIds"] = ordered_unique([*family["episodeIds"], *[episode_by_scene[scene] for scene in scene_ids if scene in episode_by_scene]])
            family["episodeUids"] = ordered_unique([*family.get("episodeUids", []), *[episode_uid_by_id[episode_by_scene[scene]] for scene in scene_ids if scene in episode_by_scene]])
            family["segmentIds"] = ordered_unique([*family["segmentIds"], *segment_ids])
            family["shotIds"] = ordered_unique([*family["shotIds"], *shot_ids])
        if not path:
            return family_id
        path_obj = ROOT / path
        label_value = (
            explicit_version_id.rsplit("@", 1)[1]
            if explicit_version_id and "@" in explicit_version_id
            else version_label(path)
        )
        legacy_version_id = explicit_version_id or f"{family_id}@{label_value}"
        if not legacy_version_id.startswith(f"{family_id}@"):
            raise ValueError(f"{path}: explicit AssetVersion does not belong to {family_id}")
        if preserve_expected_output or not path_obj.is_file():
            expected_output_id = f"EXPECTED_OUTPUT:{legacy_version_id}"
            if (
                expected_output_id in expected_outputs
                and expected_outputs[expected_output_id].get("targetPath") != path
            ):
                expected_output_id = (
                    f"{expected_output_id}-{hashlib.sha256(path.encode('utf-8')).hexdigest()[:10].upper()}"
                )
            if expected_output_id not in expected_outputs:
                expected_outputs[expected_output_id] = {
                    "id": expected_output_id,
                    "familyId": family_id,
                    "label": label_value,
                    "targetPath": path,
                    "plannedVersionLabel": label_value,
                    "legacyVersionId": legacy_version_id,
                    "expectationState": "PLANNED",
                    "sourceRef": source_ref,
                    "promptRef": prompt_ref,
                    "model": model,
                    "assetRole": asset_role,
                    "provenance": dict(provenance) if provenance else None,
                    "realizedVersionId": None,
                }
                families[family_id]["expectedOutputRefs"].append(expected_output_id)
                families[family_id]["versionDeepLinkAliases"].append(
                    {
                        "legacyVersionId": legacy_version_id,
                        "expectedOutputId": expected_output_id,
                    }
                )
            family = families[family_id]
            current_version = versions.get(family.get("currentVersionId"))
            current_version_is_usable = bool(
                current_version
                and current_version.get("materializationState") == "GENERATED"
                and current_version.get("historyStatus") != "EVIDENCE_ONLY"
                and "DO_NOT_USE" not in str(current_version.get("approvalStatus") or "")
                and current_version.get("approvalStatus") != "REJECTED"
            )
            if not current_version_is_usable:
                # A planned replacement is the current production target only
                # when no usable materialized version exists.  Historical or
                # prohibited files remain addressable through versionRefs but
                # must never occupy the family's current-version pointer.
                family["currentVersionId"] = None
                if family["currentExpectedOutputId"] is None:
                    family["currentExpectedOutputId"] = expected_output_id
            exact_path_to_family[path] = family_id
            return family_id
        actual_materialization = (
            "EVIDENCE_ONLY"
            if materialization == "EVIDENCE_ONLY" and path_obj.is_file()
            else ("GENERATED" if path_obj.is_file() else materialization)
        )
        actual_sha = sha_value or (sha256(path_obj) if path_obj.is_file() else None)
        if not actual_sha or not re.fullmatch(r"[0-9a-f]{64}", actual_sha):
            raise ValueError(f"{path}: materialized AssetVersion requires a valid SHA-256")
        vid = legacy_version_id
        if vid in versions and versions[vid].get("path") != path:
            vid = f"{vid}-{hashlib.sha256(path.encode('utf-8')).hexdigest()[:10].upper()}"
        if vid not in versions:
            versions[vid] = {
                "id": vid,
                "familyId": family_id,
                "label": label_value,
                "path": path,
                "materializationState": actual_materialization,
                "historyStatus": (
                    "EVIDENCE_ONLY"
                    if actual_materialization == "EVIDENCE_ONLY"
                    else ("CURRENT" if actual_materialization == "GENERATED" else "PLANNED")
                ),
                "qaStatus": qa,
                "approvalStatus": approval,
                "rightsStatus": rights,
                "sha256": actual_sha,
                "preview": preview,
                "audioProxy": audio_proxy,
                "promptRef": prompt_ref,
                "model": model,
                "historyId": history_id,
                "resourceId": resource_id,
                "sourceRef": source_ref,
            }
            if asset_role:
                versions[vid]["assetRole"] = asset_role
            if provenance:
                versions[vid]["provenance"] = dict(provenance)
            families[family_id]["versionRefs"].append(vid)
        family = families[family_id]
        if actual_materialization == "GENERATED":
            family["materializationState"] = "GENERATED"
            family["executionState"] = execution
            family["gateStatus"] = gate
            family["qaStatus"] = qa
            family["approvalStatus"] = approval
            family["rightsStatus"] = rights
            family["downstreamEligibility"] = eligibility
        if (
            actual_materialization == "GENERATED"
            and "DO_NOT_USE" not in str(approval or "")
            and approval != "REJECTED"
        ):
            families[family_id]["currentVersionId"] = vid
            families[family_id]["currentExpectedOutputId"] = None
        exact_path_to_family[path] = family_id
        return family_id
    add_family(output["familyId"],label="Fixture",kind="AUDIO",subtype="VOICE",source_ref="prompt.md#A",path=output["path"])
    return {"assetFamilies":list(families.values()),"assetVersions":list(versions.values()),"expectedOutputs":list(expected_outputs.values())}

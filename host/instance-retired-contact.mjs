export const retiredContactSupport = String.raw`def make_retired_contact_support(root, evidence, reports):
    import hashlib, json
    def require(ok, message):
        if not ok: raise ValueError("Retired historical contact: " + message)
    def canonical(value):
        return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    def digest(value):
        return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()
    def relative(filename):
        return filename.resolve().relative_to(root).as_posix()
    def proof_for(proxy_path):
        alias = relative(proxy_path)
        rows = [row for row in (evidence.get("media") or []) if alias in (row.get("registration") or {}).get("aliases", [])]
        if not rows: return None
        require(len(rows) == 1, "ambiguous retired registration")
        return rows[0]
    def build(key, item, original_path, proxy_path):
        proof = proof_for(proxy_path)
        if proof is None: return None
        registration, retirement = proof.get("registration") or {}, proof.get("retirement") or {}
        require(evidence.get("schemaVersion") == "1.0" and evidence.get("releaseId") and len(evidence.get("snapshotSha256", "")) == 64, "missing frozen release binding")
        require(proof.get("bindingHash") == digest({"registration": registration, "retirement": retirement}), "retirement binding bytes differ")
        require(retirement.get("phase") in ("PURGED", "QUARANTINED") and retirement.get("mediaId") == registration.get("mediaId") and retirement.get("versionId") == registration.get("versionId"), "not an exact completed version retirement")
        require(registration.get("mediaId") and registration.get("versionId") and registration.get("relativePath") == retirement.get("originalRelativePath")
                and registration.get("sha256") == retirement.get("sha256") and registration.get("byteSize") == retirement.get("byteSize"), "path/version/SHA registration differs")
        require(not original_path.exists() and not proxy_path.exists(), "retired media cannot be rematerialized or regenerated")
        old = (evidence.get("contactSheets") or {}).get(key)
        require(isinstance(old, dict) and old.get("historyRole") == "EVIDENCE_ONLY", "no exact published historical contact")
        require(all(k in old and old[k] == v for k, v in item.items()) and old.get("path") == relative(original_path), "QA item differs from published contact metadata")
        proxy_alias = relative(proxy_path)
        require(proxy_alias.startswith("review-site/public/media/storyboard-contact-sheets/"), "not a historical contact proxy")
        expected_url = "/" + proxy_alias.removeprefix("review-site/public/")
        require(old.get("reviewProxy") == expected_url and old.get("proxySha256") == registration.get("sha256"), "published proxy path/SHA differs from retired version")
        marker = {"state": retirement["phase"], "label": "历史媒体已清理", "mediaId": registration["mediaId"],
                  "versionId": registration["versionId"], "sha256": registration["sha256"], "bindingHash": proof["bindingHash"]}
        result = json.loads(json.dumps(old, ensure_ascii=False))
        result["mediaRetirement"] = marker
        reports.append({"key": key, "sourcePath": relative(original_path), "originalExpectedSha": item["sha256"],
                        "proxyPath": proxy_alias, "proxySha256": registration["sha256"], "proxyActualSha256": None,
                        "retirementState": retirement["phase"], "retirementBindingHash": proof["bindingHash"],
                        "publishedContactHash": digest(old), "cacheReleaseId": evidence["releaseId"],
                        "cacheSnapshotSha256": evidence["snapshotSha256"], "historyRole": "EVIDENCE_ONLY",
                        "mode": "RETAIN_PUBLISHED_CONTACT_METADATA_WITH_RETIRED_MEDIA"})
        return result
    return proof_for, build
`;

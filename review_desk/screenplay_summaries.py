"""Optional reading summaries keyed to published episode revisions."""
import json


def read_summaries(root):
    path = root / "content" / "screenplay-summaries.json"
    if not path.exists():
        return {"schema_version": 1, "episodes": []}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if value["schema_version"] != 1 or not isinstance(value["episodes"], list):
            raise ValueError
        seen = set()
        for item in value["episodes"]:
            key = (item["object_id"], item["revision_id"])
            if (not all(isinstance(part, str) and part for part in key)
                    or not isinstance(item["summary"], str) or not item["summary"].strip()
                    or key in seen):
                raise ValueError
            seen.add(key)
        return value
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ValueError("invalid screenplay summaries") from error

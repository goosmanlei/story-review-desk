"""Read optional instance editorial content; no business ledger or migration."""
import json


def read_document(root):
    path = root / "content" / "production-approach.json"
    if not path.exists():
        return None
    value = json.loads(path.read_text(encoding="utf-8"))
    def require(condition):
        if not condition:
            raise ValueError("invalid production approach document")

    try:
        require(value["schema_version"] == 1)
        require([tab["id"] for tab in value["tabs"]] == ["story", "materials"])
        for tab in value["tabs"]:
            require(all(isinstance(tab[key], str) for key in ("label", "title", "lead")))
            ids = set()
            for section in tab["sections"]:
                require(isinstance(section["id"], str) and section["id"].isascii())
                require(section["id"].replace("-", "").isalnum() and section["id"] not in ids)
                ids.add(section["id"])
                require(isinstance(section["title"], str))
                require(all(isinstance(text, str) for text in section.get("paragraphs", [])))
                if "note" in section:
                    require(isinstance(section["note"], str))
                for step in section.get("flow", []):
                    require(isinstance(step["title"], str) and isinstance(step["text"], str))
                if "table" in section:
                    table = section["table"]
                    require(table["columns"] and all(isinstance(text, str) for text in table["columns"]))
                    require(all(len(row) == len(table["columns"]) and all(isinstance(text, str) for text in row) for row in table["rows"]))
                for link in section.get("links", []):
                    require(isinstance(link["label"], str) and isinstance(link["href"], str))
    except (KeyError, TypeError, AttributeError) as error:
        raise ValueError("invalid production approach document") from error
    return value

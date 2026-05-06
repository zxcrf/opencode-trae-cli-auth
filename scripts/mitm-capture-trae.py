from mitmproxy import http
import json
import os


TARGET = "/api/ide/v2/llm_raw_chat"
OUT = os.environ.get("MITM_CAPTURE_OUT", "/tmp/trae-mitm-capture.jsonl")


def response(flow: http.HTTPFlow) -> None:
    if TARGET not in flow.request.pretty_url:
        return
    record = {
        "url": flow.request.pretty_url,
        "headers": {
            "Extra": flow.request.headers.get("Extra", ""),
            "X-Ide-Function": flow.request.headers.get("X-Ide-Function", ""),
        },
    }
    try:
        record["extra_json"] = json.loads(record["headers"]["Extra"]) if record["headers"]["Extra"] else None
    except Exception as exc:
        record["extra_json_error"] = str(exc)
    try:
        record["body_json"] = json.loads(flow.request.get_text())
    except Exception as exc:
        record["body_json_error"] = str(exc)
        record["body_text"] = flow.request.get_text()
    with open(OUT, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")

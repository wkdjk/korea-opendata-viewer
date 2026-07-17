"""Fetch Korea Data.go.kr open data and write static JSON for the viewer.

Runs in GitHub Actions (open network). The service key is read from the
DATA_GO_KR_KEY environment variable — never hard-coded, never committed.

Output: docs/data/customs_velvet.json, medicine.json, herbal_inspection.json,
plus meta.json (last updated + row counts). Each dataset file has the shape:

    {"dataset", "title", "last_updated", "columns", "labels", "rows", "note"}

The viewer reads whatever columns each file declares, so datasets whose fields
are not yet fully labelled still render correctly.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from xml.etree import ElementTree as ET

import requests
import yaml

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "scripts" / "config.yaml"
DATA_DIR = ROOT / "docs" / "data"
TIMEOUT = 60
PERIOD_RE = re.compile(r"^\d{4}\.\d{2}$")


def get_key() -> str:
    key = os.environ.get("DATA_GO_KR_KEY", "").strip()
    if not key:
        sys.exit("ERROR: DATA_GO_KR_KEY environment variable is not set.")
    return key


def call(url: str, params: dict) -> ET.Element | None:
    """Call an API and return the parsed XML root, or None on failure."""
    try:
        resp = requests.get(url, params=params, timeout=TIMEOUT)
        resp.raise_for_status()
    except requests.RequestException as exc:
        print(f"  ! request failed: {exc}")
        return None
    text = resp.text.strip()
    try:
        return ET.fromstring(text)
    except ET.ParseError:
        print(f"  ! not XML (first 200 chars): {text[:200]}")
        return None


def result_code(root: ET.Element) -> str:
    node = root.find(".//resultCode")
    return node.text.strip() if node is not None and node.text else ""


def items(root: ET.Element) -> list[ET.Element]:
    return root.findall(".//item")


def to_number(value: str):
    """Return an int/float if the string is numeric, else the original string."""
    if value is None:
        return ""
    v = value.strip().replace(",", "")
    if v == "":
        return ""
    try:
        return int(v)
    except ValueError:
        try:
            return float(v)
        except ValueError:
            return value.strip()


# ---------------------------------------------------------------------------
# Dataset 1 — Customs (precise, known schema)
# ---------------------------------------------------------------------------

def fetch_customs(cfg: dict, key: str, labels: dict) -> dict:
    url = cfg["base_url"]
    hs_codes = cfg["hs_codes"]
    countries = cfg["countries"]
    rows: list[dict] = []

    for hs, hs_label in hs_codes.items():
        for cnty, cnty_name in countries.items():
            for year in range(cfg["start_year"], cfg["end_year"] + 1):
                params = {
                    "serviceKey": key,
                    "strtYymm": f"{year}01",
                    "endYymm": f"{year}12",
                    "hsSgn": hs,
                    "cntyCd": cnty,
                    "numOfRows": 100,
                    "pageNo": 1,
                }
                root = call(url, params)
                if root is None:
                    continue
                code = result_code(root)
                if code and code != "00":
                    msg = root.find(".//resultMsg")
                    print(f"  {hs}/{cnty}/{year}: resultCode={code} "
                          f"({msg.text if msg is not None else ''})")
                    continue
                got = 0
                for it in items(root):
                    period = (it.findtext("year") or "").strip()
                    if not PERIOD_RE.match(period):
                        continue  # drop the "총계" summary row
                    rows.append({
                        "period": period,
                        "country_code": cnty,
                        "country": cnty_name,
                        "hs_code": hs,
                        "item": hs_label,
                        "import_weight_kg": to_number(it.findtext("impWgt")),
                        "import_value_usd": to_number(it.findtext("impDlr")),
                        "export_weight_kg": to_number(it.findtext("expWgt")),
                        "export_value_usd": to_number(it.findtext("expDlr")),
                    })
                    got += 1
                if got:
                    print(f"  {hs}/{cnty}/{year}: {got} rows")
                time.sleep(0.1)  # be gentle on the API

    rows.sort(key=lambda r: (r["period"], r["country"], r["hs_code"]))
    columns = ["period", "country_code", "country", "hs_code", "item",
               "import_weight_kg", "import_value_usd",
               "export_weight_kg", "export_value_usd"]
    return {
        "dataset": "customs_velvet",
        "title": "Customs — deer-velvet trade",
        "columns": columns,
        "labels": {c: labels.get(c, c) for c in columns},
        "rows": rows,
        "note": "Source: Korea Customs Service via data.go.kr. Monthly rows; "
                "summary totals removed.",
    }


# ---------------------------------------------------------------------------
# Datasets 2 & 3 — MFDS (generic, dynamic schema)
# ---------------------------------------------------------------------------

def prettify(key: str) -> str:
    """Turn a raw field code into a readable English-ish label as a fallback."""
    if "_" in key or key.isupper():          # e.g. BSSH_NM -> "Bssh Nm"
        return " ".join(p.capitalize() for p in key.split("_") if p)
    s = re.sub(r"(?<!^)(?=[A-Z])", " ", key).strip()   # camelCase -> "Camel Case"
    return s[:1].upper() + s[1:] if s else key


def fetch_generic(url: str, key: str, cfg: dict, labels: dict,
                  dataset: str, title: str) -> dict:
    num = cfg.get("num_of_rows", 100)
    max_rows = cfg.get("max_rows", 5000)
    extra = cfg.get("extra_params") or {}
    rows: list[dict] = []
    columns: list[str] = []
    seen = set()
    note = ""
    page = 1
    while len(rows) < max_rows:
        params = {"serviceKey": key, "pageNo": page, "numOfRows": num, "type": "xml"}
        params.update(extra)
        root = call(url, params)
        if root is None:
            note = "The API did not return valid data. Check the operation name "
            note += "and any required parameters (see config.yaml extra_params)."
            break
        code = result_code(root)
        if code and code != "00":
            msg = root.find(".//resultMsg")
            note = f"API resultCode={code}: {msg.text if msg is not None else ''}"
            print(f"  {note}")
            break
        page_items = items(root)
        if not page_items:
            break
        for it in page_items:
            row = {}
            for child in it:
                tag = child.tag
                if tag not in seen:
                    seen.add(tag)
                    columns.append(tag)
                row[tag] = to_number(child.text or "")
            rows.append(row)
        if len(page_items) < num:
            break
        page += 1
        time.sleep(0.1)

    return {
        "dataset": dataset,
        "title": title,
        "columns": columns,
        "labels": {c: labels.get(c, prettify(c)) for c in columns},
        "rows": rows[:max_rows],
        "note": note or "Source: MFDS via data.go.kr.",
    }


def discover_operation(base: str, key: str) -> str | None:
    """Try common operation names for the herbal-inspection service."""
    candidates = [
        "getNatnHbstRsrcFuncInspIncgCaseList",
        "getNatnHbstRsrcFuncInspIncgCaseInq",
        "getList",
    ]
    for op in candidates:
        root = call(f"{base}/{op}", {"serviceKey": key, "pageNo": 1,
                                     "numOfRows": 1, "type": "xml"})
        if root is not None and result_code(root) in ("", "00"):
            if items(root) or root.find(".//totalCount") is not None:
                print(f"  discovered operation: {op}")
                return op
    return None


# ---------------------------------------------------------------------------

def write(name: str, payload: dict) -> int:
    payload["last_updated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    path = DATA_DIR / f"{name}.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    n = len(payload.get("rows", []))
    print(f"wrote {path.name}: {n} rows")
    return n


def main() -> None:
    key = get_key()
    cfg = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
    labels = cfg.get("labels", {})
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    counts = {}

    if cfg.get("customs", {}).get("enabled"):
        print("== Customs (deer-velvet trade) ==")
        counts["customs_velvet"] = write("customs_velvet",
                                          fetch_customs(cfg["customs"], key, labels))

    if cfg.get("medicine", {}).get("enabled"):
        print("== Medicine production & import ==")
        payload = fetch_generic(cfg["medicine"]["base_url"], key, cfg["medicine"],
                                labels, "medicine",
                                "Medicine — production & import")
        counts["medicine"] = write("medicine", payload)

    if cfg.get("herbal_inspection", {}).get("enabled"):
        print("== Herbal-resource inspection failures ==")
        hcfg = cfg["herbal_inspection"]
        op = hcfg.get("operation") or discover_operation(hcfg["base_url"], key)
        if op:
            url = f"{hcfg['base_url']}/{op}"
            payload = fetch_generic(url, key, hcfg, labels, "herbal_inspection",
                                    "Herbal resource — inspection failures")
        else:
            payload = {
                "dataset": "herbal_inspection",
                "title": "Herbal resource — inspection failures",
                "columns": [], "labels": {}, "rows": [],
                "note": "Operation name not found. Set 'operation' in config.yaml.",
            }
        counts["herbal_inspection"] = write("herbal_inspection", payload)

    write("meta", {"datasets": counts})
    print("done.")


if __name__ == "__main__":
    main()

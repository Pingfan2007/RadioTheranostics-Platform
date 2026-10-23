#!/usr/bin/env python3
"""Build the RadioPharm knowledge graph (nodes + edges) from the offline MD snapshot.

Usage
-----
    python tools/build_kg.py --kb "<path to RadioPharm知识库-MD>" --out data/kg.json
    python tools/build_kg.py --kb "..." --out data/kg.json --enrich

What it does
------------
The snapshot is one Markdown file per entity, grouped into seven folders
(drugs, targets, radionuclides, diseases, chelators, linkers, vectors).
Every file starts with a title, a typed ID block and a key/value table;
drug files additionally carry the nuclide block and an indication list.

Edges are created only when both endpoints can be resolved.  Indications that
have no dedicated disease page in the snapshot are kept as *inline* indication
nodes (flagged ``x: 1``) so that clinical context is not silently dropped.

The snapshot's chelator/linker/vector pages list at most 50 drugs, which loses
about 40 % of the chelator links.  ``--enrich`` back-fills those lists from the
public RadioPharm endpoint the snapshot itself was exported from, caching every
response under ``tools/.cache`` so rebuilds stay offline.  Without the flag the
build is fully offline and the truncation is reported in ``meta.quality``.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

CATEGORIES = {
    "01-放射性药物": ("drug", "Drug"),
    "02-靶点": ("target", "Target"),
    "03-核素": ("nuclide", "Nuclide"),
    "04-疾病": ("disease", "Indication"),
    "05-螯合剂": ("chelator", "Chelator"),
    "06-连接子": ("linker", "Linker"),
    "07-载体": ("vector", "Vector"),
}

REL_LABEL = {
    "CONTAINS_NUCLIDE": "contains nuclide",
    "TARGETS": "targets",
    "INDICATED_FOR": "indicated for",
    "USES_CHELATOR": "uses chelator",
    "USES_LINKER": "uses linker",
    "USES_VECTOR": "uses vector",
}

PHASE_RANK = {
    "approval": 9,
    "phase 4": 8,
    "phase 3": 7,
    "phase 2/3": 6,
    "phase 2": 5,
    "phase 1/2": 4,
    "phase 1": 3,
    "clinical trial": 2,
    "preclinical": 1,
}


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "")
    s = s.replace("\u2212", "-").replace("\u2013", "-").replace("\u2014", "-")
    s = s.replace("\u00a0", " ")
    s = s.replace("**", "")
    s = re.sub(r"\s+", " ", s).strip().lower()
    return s


def clean(v: str) -> str:
    return re.sub(r"\s+", " ", v or "").strip()


def slug(s: str, limit: int = 64) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return (s[:limit].strip("-") or "item")


def parse_table(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for m in re.finditer(r"^\|\s*\*\*(.+?)\*\*\s*\|\s*(.*?)\s*\|\s*$", text, re.M):
        key, val = clean(m.group(1)), clean(m.group(2))
        if key and val and key != "字段":
            out[key] = val
    return out


def parse_header(text: str) -> tuple[str, str]:
    name = ""
    m = re.search(r"^#\s+(.+?)\s*$", text, re.M)
    if m:
        name = clean(m.group(1)).replace("**", "")
    ident = ""
    m = re.search(r"\*\*ID\*\*[：:]\s*`([^`]+)`", text)
    if m:
        ident = m.group(1).strip()
    return name, ident


def split_synonyms(v: str, limit: int = 6) -> list[str]:
    parts = [clean(p) for p in (v or "").split(";")]
    seen, out = set(), []
    for p in parts:
        if not p or len(p) > 90:
            continue
        k = norm(p)
        if k in seen:
            continue
        seen.add(k)
        out.append(p)
        if len(out) >= limit:
            break
    return out


def parse_indications(text: str) -> list[dict]:
    out = []
    for m in re.finditer(
        r"^-\s+(Treatment|Diagnosis|Therapy|Imaging)\s*\|\s*(.+?)\s*\|\s*ICD-11:\s*(.+?)\s*\|\s*(.+?)\s*$",
        text,
        re.M,
    ):
        out.append(
            {
                "application": clean(m.group(1)),
                "name": clean(m.group(2)),
                "icd11": clean(m.group(3)),
                "phase": clean(m.group(4)),
            }
        )
    return out


def parse_used_in(text: str) -> tuple[int, list[str]]:
    m = re.search(r"\*\*Used in (\d+) radiopharmaceuticals\*\*\s*\|\s*(.*?)\s*\|?\s*$", text, re.M)
    if not m:
        return 0, []
    names = []
    for part in m.group(2).split(";"):
        p = clean(part).strip("|").strip()
        if p:
            names.append(p)
    return int(m.group(1)), names


def load_category(kb: Path, folder: str, etype: str) -> list[dict]:
    rows = []
    for path in sorted((kb / folder).glob("*.md")):
        if path.name.startswith("_"):
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        name, ident = parse_header(text)
        if not name:
            continue
        rows.append(
            {
                "id": ident,
                "type": etype,
                "name": name,
                "text": text,
                "table": parse_table(text),
                "file": f"{folder}/{path.name}",
            }
        )
    return rows


# --------------------------------------------------------------------------- #
# optional enrichment (chelator pages list only the first 50 drugs offline)
# --------------------------------------------------------------------------- #
API = "https://radiopharm.idrblab.cn/api/radiopharm/postLinkerChelatorTargetheadDescription"
CACHE = Path(__file__).resolve().parent / ".cache"


def fetch_component(page_type: str, page_id: str) -> list[dict] | None:
    CACHE.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE / f"{page_type}_{page_id}.json"
    if cache_file.exists():
        try:
            return json.loads(cache_file.read_text(encoding="utf-8")).get("description_items", [])
        except json.JSONDecodeError:
            pass
    payload = json.dumps({"page_type": page_type, "page_id": page_id}).encode()
    req = urllib.request.Request(
        API,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (compatible; BRT-KG-builder/1.0)",
            "Origin": "https://radiopharm.idrblab.cn",
            "Referer": "https://radiopharm.idrblab.cn/",
        },
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                data = json.loads(r.read().decode("utf-8", "replace"))
            cache_file.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            return data.get("description_items", [])
        except Exception as exc:  # noqa: BLE001 - network best effort
            if attempt == 2:
                print(f"  ! enrich failed for {page_id}: {exc}", file=sys.stderr)
                return None
            time.sleep(1.5 * (attempt + 1))
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--kb", required=True)
    ap.add_argument("--out", default="data/kg.json")
    ap.add_argument("--enrich", action="store_true", help="back-fill truncated chelator/linker/vector lists")
    ap.add_argument("--stats-only", action="store_true")
    args = ap.parse_args()

    kb = Path(args.kb)
    if not kb.is_dir():
        print(f"KB folder not found: {kb}", file=sys.stderr)
        return 2

    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    quality = Counter()

    def nid(etype: str, ident: str) -> str:
        return f"{etype}:{ident}"

    # ---- load the seven categories --------------------------------------
    by_cat: dict[str, dict[str, dict]] = {}
    for folder, (etype, _label) in CATEGORIES.items():
        items = load_category(kb, folder, etype)
        by_cat[etype] = {it["id"]: it for it in items if it["id"]}
        quality[f"files_{etype}"] = len(items)
        print(f"{etype:8s} {len(items):5d} files")

    # three drug files in the snapshot lost their ID line: recover from the catalog
    csv_path = kb / "_总目录.csv"
    if csv_path.exists():
        catalog = {
            norm(r["名称"]): r["ID"]
            for r in csv.DictReader(csv_path.open(encoding="utf-8-sig"))
            if r.get("类型") == "放射性药物" and r.get("ID")
        }
        for it in load_category(kb, "01-放射性药物", "drug"):
            if not it["id"]:
                recovered = catalog.get(norm(it["name"]))
                if recovered:
                    it["id"] = recovered
                    by_cat["drug"][recovered] = it
                    quality["recovered_ids"] += 1
                    print(f"  recovered id for {it['name']} -> {recovered}")

    for etype, index in by_cat.items():
        for it in index.values():
            nodes[nid(etype, it["id"])] = {"id": nid(etype, it["id"]), "t": etype, "name": it["name"], "src": it["id"]}

    name_index: dict[str, dict[str, str]] = defaultdict(dict)
    for etype, index in by_cat.items():
        for it in index.values():
            name_index[etype].setdefault(norm(it["name"]), it["id"])

    def resolve(etype: str, name: str) -> str | None:
        key = norm(name)
        if key in name_index[etype]:
            return name_index[etype][key]
        alt = re.sub(r"[\[\]()]", "", key)
        alt = re.sub(r"\s+", " ", alt).strip()
        for cand, ident in name_index[etype].items():
            c = re.sub(r"[\[\]()]", "", cand)
            c = re.sub(r"\s+", " ", c).strip()
            if c == alt:
                return ident
        return None

    # ---- node properties -------------------------------------------------
    phase_best: dict[str, str] = {}
    for ident, it in by_cat["drug"].items():
        t = it["table"]
        nodes[nid("drug", ident)]["p"] = {
            "drugType": t.get("Drug Type", ""),
            "synonyms": split_synonyms(t.get("Synonyms", "")),
        }

    for ident, it in by_cat["nuclide"].items():
        t = it["table"]
        nodes[nid("nuclide", ident)]["p"] = {
            "halfLife": t.get("half life", ""),
            "radiation": t.get("radiation", ""),
            "decay": t.get("decay modes", ""),
            "energy": t.get("energy", ""),
            "range": t.get("range", ""),
            "daughter": t.get("daughter", ""),
            "let": t.get("let", ""),
            "source": t.get("decay sources", ""),
            "cytotoxicity": t.get("cytotoxicity", ""),
        }

    for ident, it in by_cat["target"].items():
        t = it["table"]
        nodes[nid("target", ident)]["p"] = {
            "genes": t.get("Gene names", ""),
            "uniprot": t.get("UniProt", ""),
            "function": (t.get("Function", "") or "")[:420],
        }

    for ident, it in by_cat["disease"].items():
        t = it["table"]
        nodes[nid("disease", ident)]["p"] = {"icd11": t.get("ICD-11", ""), "category": t.get("Category", "")}

    for etype in ("chelator", "linker", "vector"):
        for ident, it in by_cat[etype].items():
            t = it["table"]
            nodes[nid(etype, ident)]["p"] = {"formula": t.get("mf", ""), "cid": t.get("cid", "")}

    # ---- edges -----------------------------------------------------------
    edge_keys: set[tuple[str, str, str]] = set()

    def add_edge(s: str, t: str, rel: str, props: dict | None = None) -> bool:
        if s == t or s not in nodes or t not in nodes:
            return False
        key = (s, t, rel)
        if key in edge_keys:
            return False
        edge_keys.add(key)
        rec = {"s": s, "t": t, "r": rel}
        if props:
            rec["p"] = {k: v for k, v in props.items() if v and v != "N.A."}
        edges.append(rec)
        return True

    inline_disease: dict[str, str] = {}

    def disease_node(name: str, icd11: str = "") -> str | None:
        found = resolve("disease", name)
        if found:
            return nid("disease", found)
        key = norm(name)
        if not key:
            return None
        if key not in inline_disease:
            digest = hashlib.sha1(key.encode()).hexdigest()[:8]
            node_id = f"disease:x:{slug(name)}-{digest}"
            nodes[node_id] = {"id": node_id, "t": "disease", "name": name, "src": "inline", "inline": True}
            nodes[node_id]["p"] = {"icd11": icd11} if icd11 and icd11 != "N.A." else {}
            inline_disease[key] = node_id
            quality["inline_indications"] += 1
        return inline_disease[key]

    for ident, it in by_cat["drug"].items():
        src = nid("drug", ident)
        t = it["table"]

        nuc_name = t.get("nuclide name", "")
        if nuc_name:
            dst = resolve("nuclide", nuc_name)
            if dst:
                add_edge(src, nid("nuclide", dst), "CONTAINS_NUCLIDE")
            else:
                quality["unresolved_nuclide"] += 1

        for tname in (x for x in (t.get("Drug Targets", "") or "").split(";") if clean(x)):
            dst = resolve("target", tname)
            if dst:
                add_edge(src, nid("target", dst), "TARGETS")
            else:
                quality["unresolved_target"] += 1

        for ind in parse_indications(it["text"]):
            dst = disease_node(ind["name"], ind["icd11"])
            if not dst:
                quality["unresolved_indication"] += 1
                continue
            add_edge(src, dst, "INDICATED_FOR", {"app": ind["application"], "phase": ind["phase"], "icd11": ind["icd11"]})
            rank = PHASE_RANK.get(norm(ind["phase"]), 0)
            if rank > PHASE_RANK.get(norm(phase_best.get(ident, "")), 0):
                phase_best[ident] = ind["phase"]

    # component -> drug (reverse lists)
    component_rel = {"chelator": "USES_CHELATOR", "linker": "USES_LINKER", "vector": "USES_VECTOR"}
    coverage = Counter()
    enrich_targets: list[tuple[str, str, str]] = []

    for etype, rel in component_rel.items():
        for ident, it in by_cat[etype].items():
            declared, names = parse_used_in(it["text"])
            coverage[f"{etype}_declared"] += declared
            coverage[f"{etype}_listed"] += len(names)
            if declared > len(names):
                enrich_targets.append((etype, ident, rel))
            for dname in names:
                drug_id = resolve("drug", dname)
                if not drug_id:
                    quality[f"unresolved_{etype}_drug"] += 1
                    continue
                add_edge(nid("drug", drug_id), nid(etype, ident), rel)

    if args.enrich and enrich_targets:
        state = {"ok": 0, "fail": 0, "added": 0}

        def work(job):
            etype, ident, rel = job
            items = fetch_component(f"{etype}_id", ident)
            if items is None:
                state["fail"] += 1
                return
            state["ok"] += 1
            for item in items:
                did = item.get("drug_id")
                if did and add_edge(nid("drug", did), nid(etype, ident), rel):
                    state["added"] += 1

        print(f"enriching {len(enrich_targets)} truncated component pages ...")
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(work, enrich_targets))
        print(f"  ok={state['ok']} fail={state['fail']} new-edges={state['added']}")
        quality["enriched_pages"] = state["ok"]
        quality["enriched_edges"] = state["added"]

    # phase summary on drugs
    for ident, phase in phase_best.items():
        p = nodes[nid("drug", ident)].get("p")
        if p is not None:
            p["phase"] = phase

    # ---- degrees & pruning ----------------------------------------------
    deg = Counter()
    for e in edges:
        deg[e["s"]] += 1
        deg[e["t"]] += 1
    used = {e["s"] for e in edges} | {e["t"] for e in edges}
    nodes = {k: v for k, v in nodes.items() if k in used}

    # ---- serialise -------------------------------------------------------
    order = sorted(nodes.values(), key=lambda n: (n["t"], -deg[n["id"]], n["name"].lower()))
    idx = {n["id"]: i for i, n in enumerate(order)}
    out_nodes = []
    for n in order:
        rec = {"i": n["id"], "t": n["t"], "n": n["name"], "d": deg[n["id"]]}
        if n.get("p"):
            rec["p"] = n["p"]
        if n.get("inline"):
            rec["x"] = 1
        out_nodes.append(rec)
    out_edges = [{"s": idx[e["s"]], "t": idx[e["t"]], "r": e["r"], **({"p": e["p"]} if e.get("p") else {})} for e in edges]

    type_counts = Counter(n["t"] for n in out_nodes)
    rel_counts = Counter(e["r"] for e in out_edges)
    payload = {
        "meta": {
            "source": "RadioPharm (IDRlab) offline Markdown snapshot",
            "sourceUrl": "https://radiopharm.idrblab.cn",
            "built": date.today().isoformat(),
            "counts": {
                "nodes": len(out_nodes),
                "edges": len(out_edges),
                "byType": dict(type_counts),
                "byRelation": dict(rel_counts),
            },
            "quality": {
                "unresolved": {k: v for k, v in quality.items() if k.startswith("unresolved")},
                "recoveredIds": quality.get("recovered_ids", 0),
                "inlineIndications": quality.get("inline_indications", 0),
                "componentCoverage": dict(coverage),
                "enrichedPages": quality.get("enriched_pages", 0),
                "enrichedEdges": quality.get("enriched_edges", 0),
            },
        },
        "types": {etype: {"label": label} for etype, label in CATEGORIES.values()},
        "relations": REL_LABEL,
        "nodes": out_nodes,
        "edges": out_edges,
    }

    print("\n--- summary ---")
    print("nodes", len(out_nodes), dict(type_counts))
    print("edges", len(out_edges), dict(rel_counts))
    print("quality", json.dumps(payload["meta"]["quality"], ensure_ascii=False))

    if not args.stats_only:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"wrote {out} ({out.stat().st_size/1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""
Creates the small test files in tests/fixtures/ (they are committed, so this
only needs to run again if you change it):

    python tests/make_fixtures.py
"""
from __future__ import annotations

import gzip
import json
import random
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "fixtures"


def write(path: str, data: str | bytes, encoding: str = "utf-8") -> None:
    p = ROOT / path
    p.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, str):
        data = data.encode(encoding)
    p.write_bytes(data)


def write_gz(path: str, text: str) -> None:
    """gzip with a fixed timestamp, so the file is the same every time."""
    p = ROOT / path
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0, filename="") as f:
        f.write(text.encode("utf-8"))


def record(i: int, rnd: random.Random) -> dict:
    r = {
        "id": i, "part": f"PT-{i % 97:05d}", "size": round(rnd.gauss(12.5, 0.3), 4),
        "ok": rnd.random() > 0.05, "date": f"2026-{1 + i % 12:02d}-{1 + i % 28:02d}",
        "time": f"2026-10-01T{i % 24:02d}:{i % 60:02d}:{(i * 7) % 60:02d}",
        "customer": {"name": f"Customer {i % 31}", "country": rnd.choice(["MX", "ES", "FR"]),
                     "contact": {"email": f"c{i % 31}@example.com"}},
        "tags": ["a", "b"][: i % 3], "note": None if i % 10 else "check ñ",
    }
    if i % 50 == 0:
        r["extra"] = i * 2          # a column that only appears sometimes
    if i % 7 == 0:
        del r["size"]               # a missing key
    return r


def main() -> None:
    shutil.rmtree(ROOT, ignore_errors=True)
    rnd = random.Random(7)

    # ---------------------------------------------------------------- CSV
    lines = ["id,customer,amount,date,comment"]
    for i in range(1, 301):
        lines.append(f"{i},Customer {i},{rnd.uniform(10, 9999):.2f},2026-{1 + i % 12:02d}-{1 + i % 28:02d},"
                     + ("\"Order, urgent\"" if i % 25 == 0 else "OK"))
    write("csv/sales.csv", "\n".join(lines) + "\n")

    # Excel-style export: BOM, semicolons, decimal comma, messy header
    rows = ["﻿ Order ;Artículo;;Artículo;order"]
    rows += [f"{i};A{i};;B{i};{i * 10},5" for i in range(50)]
    write("csv/erp_export.csv", "\r\n".join(rows) + "\r\n")

    # Spanish Excel CSV in Windows-1252 with dd/mm/yyyy dates
    rows = ["Código;Descripción;Cantidad;Precio unitario;Fecha recepción;Almacén"]
    for i in range(200):
        rows.append(f"C{i:04d};Pieza ñandú {i};{i % 17};{rnd.uniform(1, 500):.2f}".replace(".", ",")
                    + f";{1 + i % 28:02d}/{1 + i % 12:02d}/2026;Almacén {'Norte' if i % 2 else 'Sur'}")
    write("csv/inventory_es.csv", "\r\n".join(rows) + "\r\n", encoding="cp1252")

    # A column that is numeric until a text value appears near the end
    rows = ["reading,batch,value"]
    rows += [f"{i},{1000 + i},{i * 0.5}" for i in range(2000)]
    rows += ["2000,N/D,1000.0"]
    write("csv/late_text.csv", "\n".join(rows) + "\n")

    write("csv/malformed.csv", "a,b,c\n1,2,3\n4,5,6,7\n8,9,10\n")
    write("csv/empty.csv", "")
    write("csv/header_only.csv", "x;y;z\n")
    write("csv/plant/defects.tsv", "NC\tPart\tDefect\tSeverity\n"
          + "".join(f"NC-{i}\tSpar {i}\t{'Corrosión' if i % 2 else 'Grieta'}\t{1 + i % 3}\n" for i in range(1, 81)))
    write_gz("csv/plant/history.csv.gz", "day,count\n" + "".join(f"{i},{i * 3}\n" for i in range(2000)))

    # ---------------------------------------------------------------- JSON
    records = [record(i, rnd) for i in range(400)]
    write("json/list.json", json.dumps(records, ensure_ascii=False, indent=2))
    write("json/lines.jsonl", "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records))
    write("json/wrapper.json", json.dumps({"meta": {"source": "ERP", "tags": ["x"]}, "empty": [], "scalars": [1, 2, 3],
                                           "data": records[:120], "total": 120}, ensure_ascii=False))
    write("json/single_object.json", json.dumps({"a": 1, "b": {"c": "x"}, "date": "05/03/2026"}))
    write("json/mixed.json", json.dumps([
        {"code": 123, "value": 1, "big": 9007199254740993, "huge": 123456789012345678901234567890,
         "ts": "2026-01-01T10:00:00Z", "day": "2026-02-03", "txt": "007"},
        {"code": "A-12", "value": 2.5, "big": 9007199254740995, "huge": 1, "ts": "2026-01-01T10:00:00+02:00",
         "day": "", "txt": "008"},
        {"code": 7, "value": None, "big": -9223372036854775808, "huge": 2, "ts": None, "day": "2026-02-05", "txt": "x"},
    ]))
    write("json/escapes.json", json.dumps([{"ke\"y": "va\\lue \"quoted\" \n break", "ñ": "é", " spaces ": 1, "": 2,
                                            "A": 1, "a": 2}], ensure_ascii=True))
    write("json/bad_line.jsonl", '{"a":1}\n{"a":2}\n{"a": 3,,}\n[1,2]\n{"a":5}\n')
    write("json/scalars.json", "[1, 2, 3]")
    write("json/broken.json", '[{"a":1},{"a":2')
    write("json/empty_list.json", "[]")
    write("json/empty.json", "")
    write_gz("json/nested/compressed.jsonl.gz", "".join(json.dumps(r) + "\n" for r in records[:150]))
    print("Fixtures written to", ROOT)


if __name__ == "__main__":
    main()

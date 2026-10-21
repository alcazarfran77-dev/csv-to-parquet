"""
The browser engine (web/src/engine.js) must produce the same data as the
desktop engine. Runs only when Node.js and the web dependencies are installed
(cd web && npm ci).
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pyarrow.parquet as pq
import pytest

import engine
from engine import Options

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None or not (WEB / "node_modules/hyparquet-writer").exists(),
    reason="Node.js or the web dependencies are not installed (cd web && npm ci)",
)

# Known, documented differences for CSV: the browser stores dd/mm/yyyy dates without time as DATE.
CSV_DIFFERENCES = {"csv/inventory_es.parquet"}


def test_same_output_as_the_browser_engine(fixtures, tmp_path):
    py_out, js_out = tmp_path / "py", tmp_path / "js"
    jobs = engine.list_files([fixtures], recursive=True)
    engine.convert_batch(jobs, py_out, Options(keep_structure=True))
    subprocess.run(["node", str(WEB / "test/run-node.mjs"), str(fixtures), str(js_out)],
                   check=True, capture_output=True, cwd=WEB)
    py_files = sorted(p.relative_to(py_out).as_posix() for p in py_out.rglob("*.parquet"))
    js_files = sorted(p.relative_to(js_out).as_posix() for p in js_out.rglob("*.parquet"))
    assert py_files == js_files and len(py_files) >= 14
    for rel in py_files:
        a, b = pq.read_table(py_out / rel), pq.read_table(js_out / rel)
        if rel in CSV_DIFFERENCES:
            assert a.num_rows == b.num_rows and a.column_names == b.column_names, rel
            continue
        assert a.schema.remove_metadata().equals(b.schema.remove_metadata()), rel
        assert a.equals(b), rel

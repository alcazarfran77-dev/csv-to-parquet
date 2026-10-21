"""Tests of the conversion engine of the desktop app (desktop/engine.py)."""
from __future__ import annotations

import datetime as dt
import threading
from pathlib import Path

import pyarrow as pa
import pyarrow.dataset as ds
import pyarrow.parquet as pq
import pytest

import engine
from engine import Options

UTC = dt.timezone.utc


def convert(source: Path, out: Path, **options):
    """Converts one file to out/<name>.parquet and returns (result, table or None)."""
    op = Options(**options)
    target = out / (engine.base_name(source) + ".parquet")
    r = engine.convert_file(source, target, op)
    table = None
    if r.status == "ok":
        table = ds.dataset(engine.parts_folder(target)).to_table() if r.parts else pq.read_table(target)
    return r, table


def keys(r) -> list[str]:
    return [m.key for m in r.messages]


# --------------------------------------------------------------------------- CSV
def test_csv_basic_types(fixtures, tmp_path):
    r, t = convert(fixtures / "csv/sales.csv", tmp_path)
    assert r.status == "ok" and r.rows == 300 and r.columns == 5
    assert r.separator == "," and r.encoding == "utf-8"
    assert [f.type for f in t.schema] == [pa.int64(), pa.string(), pa.float64(), pa.date32(), pa.string()]
    assert t.column("comment").to_pylist()[24] == "Order, urgent"      # quoted value with the separator


def test_csv_excel_export_clean_header_and_decimal_comma(fixtures, tmp_path):
    r, t = convert(fixtures / "csv/erp_export.csv", tmp_path)
    assert r.status == "ok" and r.separator == ";" and r.decimal == ","
    assert t.column_names == ["Order", "Artículo", "column_3", "Artículo_2", "order_2"]
    assert t.column("order_2").to_pylist()[:3] == [0.5, 10.5, 20.5]


def test_csv_windows_1252_and_dmy_dates(fixtures, tmp_path):
    r, t = convert(fixtures / "csv/inventory_es.csv", tmp_path)
    assert r.status == "ok" and r.encoding == "cp1252" and r.decimal == ","
    assert t.column_names[0] == "Código"
    assert t.column("Descripción")[0].as_py() == "Pieza ñandú 0"
    assert t.schema.field("Fecha recepción").type == pa.timestamp("ms")
    assert t.column("Fecha recepción")[0].as_py() == dt.datetime(2026, 1, 1)


def test_csv_without_dmy_dates_keeps_text(fixtures, tmp_path):
    _, t = convert(fixtures / "csv/inventory_es.csv", tmp_path, dmy_dates=False)
    assert t.schema.field("Fecha recepción").type == pa.string()


def test_csv_column_that_turns_into_text(fixtures, tmp_path):
    r, t = convert(fixtures / "csv/late_text.csv", tmp_path)
    assert r.status == "ok" and r.rows == 2001
    assert t.schema.field("batch").type == pa.string()
    assert t.column("batch")[-1].as_py() == "N/D"


def test_csv_all_text(fixtures, tmp_path):
    _, t = convert(fixtures / "csv/sales.csv", tmp_path, all_text=True)
    assert all(f.type == pa.string() for f in t.schema)


def test_csv_malformed_row(fixtures, tmp_path):
    r, _ = convert(fixtures / "csv/malformed.csv", tmp_path)
    assert r.status == "error" and keys(r) == ["err_wrong_columns_norow"]
    assert "4,5,6,7" in r.message
    assert not (tmp_path / "malformed.parquet").exists()          # nothing half-written
    r, t = convert(fixtures / "csv/malformed.csv", tmp_path, skip_bad_rows=True)
    assert r.status == "ok" and r.rows == 2 and r.skipped_rows == 1
    assert "note_skipped_rows" in keys(r)


def test_csv_empty_and_header_only(fixtures, tmp_path):
    r, _ = convert(fixtures / "csv/empty.csv", tmp_path)
    assert r.status == "error" and keys(r) == ["err_empty_file"]
    r, t = convert(fixtures / "csv/header_only.csv", tmp_path)
    assert r.status == "ok" and t.num_rows == 0 and t.column_names == ["x", "y", "z"]


def test_csv_tsv_and_gzip(fixtures, tmp_path):
    r, t = convert(fixtures / "csv/plant/defects.tsv", tmp_path)
    assert r.status == "ok" and r.separator == "\t" and t.column("Defect")[0].as_py() == "Corrosión"
    r, t = convert(fixtures / "csv/plant/history.csv.gz", tmp_path)
    assert r.status == "ok" and r.rows == 2000 and t.column("count")[-1].as_py() == 5997


def test_csv_utf8_with_windows_1252_after_the_sample(tmp_path):
    # the first megabyte is plain ASCII (looks like UTF-8); a Windows-1252 "ñ" comes later
    src = tmp_path / "mixed_encoding.csv"
    lines = ["id,name"] + [f"{i},plain text {i}" for i in range(80_000)] + ["80000,Espa\xf1a"]
    src.write_bytes("\n".join(lines).encode("latin-1") + b"\n")
    r, t = convert(src, tmp_path / "out")
    assert r.status == "ok" and r.encoding == "cp1252"
    assert "note_encoding_adjusted" in keys(r)
    assert t.column("name")[-1].as_py() == "España"


def test_preview(fixtures):
    table, fmt = engine.preview(fixtures / "csv/sales.csv", Options(), rows=10)
    assert table.num_rows == 10 and fmt.separator == ","
    table, fmt = engine.preview(fixtures / "json/wrapper.json", Options(), rows=5)
    assert table.num_rows == 5 and str(fmt.describe()) == "JSON (records in “data”)"


# --------------------------------------------------------------------------- JSON
@pytest.mark.parametrize("name,description", [
    ("list.json", "JSON (list of objects)"),
    ("lines.jsonl", "JSON Lines (one object per line)"),
    ("nested/compressed.jsonl.gz", "JSON Lines (one object per line)"),
])
def test_json_shapes(fixtures, tmp_path, name, description):
    r, t = convert(fixtures / "json" / name, tmp_path)
    assert r.status == "ok" and str(r.format) == description
    assert "customer.contact.email" in t.column_names              # nested objects are flattened
    assert t.schema.field("tags").type == pa.string()              # lists are stored as JSON text
    assert t.column("tags")[2].as_py() == '["a","b"]'
    assert t.column("size")[0].as_py() is None                     # missing key -> empty
    assert t.schema.field("date").type == pa.date32()
    assert t.schema.field("time").type == pa.timestamp("ms")


def test_json_list_and_lines_are_identical(fixtures, tmp_path):
    _, a = convert(fixtures / "json/list.json", tmp_path / "a")
    _, b = convert(fixtures / "json/lines.jsonl", tmp_path / "b")
    assert a.equals(b)


def test_json_wrapper_and_single_object(fixtures, tmp_path):
    r, t = convert(fixtures / "json/wrapper.json", tmp_path)
    assert r.status == "ok" and r.rows == 120 and str(r.format) == "JSON (records in “data”)"
    r, t = convert(fixtures / "json/single_object.json", tmp_path)
    assert r.status == "ok" and t.to_pylist() == [{"a": 1, "b.c": "x", "date": dt.date(2026, 3, 5)}]


def test_json_mixed_types_and_big_integers(fixtures, tmp_path):
    r, t = convert(fixtures / "json/mixed.json", tmp_path)
    assert r.status == "ok" and "note_mixed_columns" in keys(r)
    s = t.schema
    assert s.field("code").type == pa.string()
    assert s.field("value").type == pa.float64()
    assert s.field("big").type == pa.int64()
    assert t.column("big").to_pylist() == [9007199254740993, 9007199254740995, -9223372036854775808]
    assert s.field("huge").type == pa.string()                      # does not fit in INT64
    assert s.field("ts").type == pa.timestamp("ms", tz="UTC")
    assert t.column("ts")[1].as_py() == dt.datetime(2026, 1, 1, 8, 0, tzinfo=UTC)
    assert s.field("day").type == pa.date32() and t.column("day")[1].as_py() is None
    assert t.column("txt").to_pylist() == ["007", "008", "x"]


def test_json_odd_keys(fixtures, tmp_path):
    _, t = convert(fixtures / "json/escapes.json", tmp_path)
    assert t.column_names == ['ke"y', "ñ", "spaces", "column_4", "A", "a_2"]
    assert t.column('ke"y')[0].as_py() == 'va\\lue "quoted" \n break'


@pytest.mark.parametrize("name,key", [
    ("scalars.json", "err_json_scalars"),
    ("broken.json", "err_json_incomplete"),
    ("empty_list.json", "err_json_no_records"),
    ("empty.json", "err_empty_file"),
    ("bad_line.jsonl", "err_json_bad_line"),
])
def test_json_errors(fixtures, tmp_path, name, key):
    r, _ = convert(fixtures / "json" / name, tmp_path)
    assert r.status == "error" and keys(r) == [key]


def test_json_skip_bad_lines(fixtures, tmp_path):
    r, t = convert(fixtures / "json/bad_line.jsonl", tmp_path, skip_bad_rows=True)
    assert r.status == "ok" and t.column("a").to_pylist() == [1, 2, 5] and r.skipped_rows == 2


# --------------------------------------------------------------------------- split
def test_split_by_rows(fixtures, tmp_path):
    r, t = convert(fixtures / "json/list.json", tmp_path, split_mode="rows", split_value=150)
    folder = tmp_path / "list"
    assert r.status == "ok" and r.parts == 3
    assert sorted(p.name for p in folder.iterdir()) == ["list_0001.parquet", "list_0002.parquet", "list_0003.parquet"]
    assert [pq.read_metadata(p).num_rows for p in sorted(folder.iterdir())] == [150, 150, 100]
    _, whole = convert(fixtures / "json/list.json", tmp_path / "whole")
    assert t.equals(whole)


def test_split_by_size(tmp_path):
    src = tmp_path / "big.csv"
    src.write_text("id,text\n" + "".join(f"{i},row number {i} with some padding text\n" for i in range(200_000)))
    r, t = convert(src, tmp_path / "out", split_mode="mb", split_value=0.5)
    assert r.status == "ok" and r.parts > 2 and t.num_rows == 200_000
    sizes = [p.stat().st_size for p in (tmp_path / "out/big").iterdir()]
    assert max(sizes) < 0.5 * 1024 * 1024 * 1.25


def test_split_overwrite_removes_leftover_parts_and_skips_existing(fixtures, tmp_path):
    convert(fixtures / "json/list.json", tmp_path, split_mode="rows", split_value=100)
    assert len(list((tmp_path / "list").iterdir())) == 4
    r, _ = convert(fixtures / "json/list.json", tmp_path, split_mode="rows", split_value=100)
    assert r.status == "skipped" and keys(r) == ["skipped_exists"]
    r, _ = convert(fixtures / "json/list.json", tmp_path, split_mode="rows", split_value=300, overwrite=True)
    assert r.status == "ok" and sorted(p.name for p in (tmp_path / "list").iterdir()) == ["list_0001.parquet",
                                                                                          "list_0002.parquet"]


# --------------------------------------------------------------------------- batch / combine
def test_batch_next_to_each_file_and_events(fixtures):
    jobs = engine.list_files([fixtures / "csv"], recursive=True)
    events = []
    results = engine.convert_batch(jobs, None, Options(), lambda e, *d: events.append(e))
    assert {r.source.name: r.status for r in results}["sales.csv"] == "ok"
    assert (fixtures / "csv/sales.parquet").exists() and (fixtures / "csv/plant/defects.parquet").exists()
    assert events.count("done") == len(jobs) and "start" in events


def test_batch_to_other_folder_keeps_structure(fixtures, tmp_path):
    jobs = engine.list_files([fixtures / "csv"], recursive=True)
    engine.convert_batch(jobs, tmp_path / "out", Options(keep_structure=True))
    assert (tmp_path / "out/plant/history.parquet").exists()


def test_not_recursive(fixtures):
    jobs = engine.list_files([fixtures / "csv"], recursive=False)
    assert all(f.parent == fixtures / "csv" for f, _ in jobs)


def test_combine_reconciles_schemas(tmp_path):
    (tmp_path / "a.csv").write_text("id,amount,only_a\n1,10,x\n2,20,y\n")
    (tmp_path / "b.csv").write_text("id,amount,only_b\n3,30.5,2026-01-01\n")
    jobs = engine.list_files([tmp_path], recursive=False)
    logs = []
    results = engine.convert_batch(jobs, tmp_path / "out", Options(combine=True, source_column=True),
                                   lambda e, *d: logs.append(d[0]) if e == "log" else None)
    assert [r.status for r in results] == ["ok", "ok"]
    t = pq.read_table(tmp_path / "out/combined.parquet")
    assert t.column_names == ["id", "amount", "only_a", "only_b", "source_file"]
    assert t.schema.field("amount").type == pa.float64()           # int + float -> float
    assert t.column("only_b").to_pylist() == [None, None, dt.date(2026, 1, 1)]
    assert t.column("source_file").to_pylist() == ["a.csv", "a.csv", "b.csv"]
    assert any(m.key == "log_combined" for m in logs)


def test_combine_split(fixtures, tmp_path):
    jobs = engine.list_files([fixtures / "json/list.json", fixtures / "json/wrapper.json"], recursive=False)
    engine.convert_batch(jobs, tmp_path, Options(combine=True, split_mode="rows", split_value=200))
    assert ds.dataset(tmp_path / "combined").count_rows() == 520
    assert len(list((tmp_path / "combined").iterdir())) == 3


def test_cancel(fixtures, tmp_path):
    cancel = threading.Event()
    cancel.set()
    r = engine.convert_file(fixtures / "json/list.json", tmp_path / "list.parquet", Options(), cancel=cancel)
    assert r.status == "cancelled" and not (tmp_path / "list.parquet").exists()


# --------------------------------------------------------------------------- command line
def test_cli(fixtures, tmp_path, capsys):
    code = engine.main([str(fixtures / "json/list.json"), "-o", str(tmp_path), "--lang", "es"])
    assert code == 0 and (tmp_path / "list.parquet").exists()
    assert "400 filas" in capsys.readouterr().out
    code = engine.main([str(fixtures / "csv/malformed.csv"), "-o", str(tmp_path)])
    assert code == 1


def test_cli_glob(fixtures, tmp_path):
    code = engine.main([str(fixtures / "json" / "*.json"), "-o", str(tmp_path), "--split-rows", "1000"])
    assert code == 1                                                # some fixtures are broken on purpose
    assert (tmp_path / "list/list_0001.parquet").exists()


def test_glob_patterns_keep_the_folder_structure(fixtures, tmp_path, monkeypatch):
    monkeypatch.chdir(fixtures)
    jobs, unmatched = engine.collect_jobs(["csv/**/*.tsv", "json/*.jsonl", "nothing/*.csv", "csv/plant"])
    assert unmatched == ["nothing/*.csv"]
    assert [(f.as_posix(), r.as_posix()) for f, r in jobs] == [
        ("csv/plant/defects.tsv", "csv"), ("json/bad_line.jsonl", "json"), ("json/lines.jsonl", "json"),
        ("csv/plant/history.csv.gz", "csv/plant"),
    ]
    engine.convert_batch(jobs[:1], tmp_path, Options())
    assert (tmp_path / "plant/defects.parquet").exists()

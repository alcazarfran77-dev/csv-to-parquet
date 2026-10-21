"""Both languages must have the same strings, with the same placeholders."""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

import engine
import i18n

ROOT = Path(__file__).resolve().parent.parent
PLACEHOLDER = re.compile(r"\{(\w+)\}")


def placeholders(value) -> set[str]:
    texts = [value["one"], value["other"]] if isinstance(value, dict) else [value]
    return {p for t in texts for p in PLACEHOLDER.findall(t)}


def test_same_keys_and_placeholders():
    en, es = i18n.strings("en"), i18n.strings("es")
    assert set(en) == set(es)
    for key in en:
        assert placeholders(en[key]) == placeholders(es[key]), key
        assert isinstance(en[key], dict) == isinstance(es[key], dict), key
        if isinstance(en[key], dict):
            assert set(en[key]) == {"one", "other"} and set(es[key]) == {"one", "other"}, key


def test_locale_files_are_valid_utf8_json():
    for code in i18n.LANGUAGES:
        json.loads((ROOT / "locales" / f"{code}.json").read_text(encoding="utf-8"))


def test_every_key_used_in_the_code_exists():
    pattern = re.compile(r"""(?:Msg|ConversionError|\bt|_set_status|new Msg)\(\s*['"]([a-z][a-z0-9_]+)['"]""")
    html = re.compile(r'data-i18n(?:-aria-label)?="([a-z0-9_]+)"')
    sources = list((ROOT / "desktop").glob("*.py")) + list((ROOT / "web/src").glob("*.js"))
    used = set()
    for f in sources:
        used |= set(pattern.findall(f.read_text(encoding="utf-8")))
    used |= set(html.findall((ROOT / "web/src/index.html").read_text(encoding="utf-8")))
    tables = [engine.SEPARATOR_KEYS.values()]
    for t in tables:
        used |= set(t)
    missing = sorted(k for k in used if k not in i18n.strings("en"))
    assert not missing


def test_formatting_per_language():
    i18n.set_language("en")
    assert i18n.fmt_int(1234567) == "1,234,567"
    assert i18n.fmt_bytes(1536) == "1.5 KB"
    assert i18n.fmt_seconds(4.25) == "4.2 s"
    assert i18n.t("rows_count", n=1) == "1 row" and i18n.t("rows_count", n=2000) == "2,000 rows"
    i18n.set_language("es")
    assert i18n.fmt_int(1234567) == "1.234.567"
    assert i18n.fmt_bytes(1536) == "1,5 KB"
    assert i18n.t("rows_count", n=2000) == "2.000 filas"
    assert i18n.t("zone_count", n=3, size=2048) == "3 archivos · 2,0 KB"
    assert i18n.fmt_seconds(125) == "2 min 05 s"


def test_messages_follow_the_language():
    m = engine.Msg("note_skipped_rows", n=3)
    i18n.set_language("en")
    assert str(m) == "3 malformed rows skipped."
    i18n.set_language("es")
    assert str(m) == "Se omitieron 3 filas mal formadas."


def test_parameter_called_key():
    assert str(engine.Msg("fmt_json_key", key="data")) == "JSON (records in “data”)"


@pytest.mark.parametrize("env,expected", [("es_ES.UTF-8", "es"), ("es_MX", "es"), ("en_US.UTF-8", "en"), ("fr_FR", "en")])
def test_detect_language(monkeypatch, env, expected):
    monkeypatch.setattr(i18n.sys, "platform", "linux")
    for var in ("LC_ALL", "LC_MESSAGES", "LANGUAGE"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("LANG", env)
    assert i18n.detect_language() == expected


def test_unknown_language_falls_back_to_english():
    i18n.set_language("de")
    assert i18n.get_language() == "en"

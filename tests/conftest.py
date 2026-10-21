import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "desktop"))

import i18n  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"


@pytest.fixture(autouse=True)
def english():
    """Every test starts in English (tests that need Spanish switch on their own)."""
    i18n.set_language("en")
    yield
    i18n.set_language("en")


@pytest.fixture
def fixtures(tmp_path) -> Path:
    """A private copy of tests/fixtures, so tests can write next to the files."""
    target = tmp_path / "fixtures"
    shutil.copytree(FIXTURES, target)
    return target

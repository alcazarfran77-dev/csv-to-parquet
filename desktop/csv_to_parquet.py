"""
CSV to Parquet - desktop app.

Converts CSV and JSON files (one, several or a whole folder) to Apache
Parquet. Everything happens on this computer. English and Spanish interface.

Run:       python csv_to_parquet.py [files or folders]
Requires:  pyarrow  (tkinterdnd2 optional, for drag and drop)
"""
from __future__ import annotations

import csv
import datetime as dt
import json
import os
import queue
import subprocess
import sys
import threading
import time
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk
import tkinter.font as tkfont

sys.path.insert(0, str(Path(__file__).resolve().parent))
import i18n  # noqa: E402
from i18n import t  # noqa: E402

CONFIG_FILE = Path.home() / ".csv_to_parquet.json"


def read_config() -> dict:
    try:
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def save_config(config: dict) -> None:
    try:
        CONFIG_FILE.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass


_config = read_config()
i18n.set_language(_config.get("language") or i18n.detect_language())

try:
    import pyarrow as pa
    import engine
    from engine import Msg
except ImportError as _e:  # pragma: no cover - friendly message if pyarrow is missing
    _r = tk.Tk()
    _r.withdraw()
    messagebox.showerror(t("dlg_missing_lib_title"), t("dlg_missing_lib", detail=str(_e)))
    raise SystemExit(1)

try:
    from tkinterdnd2 import DND_FILES, TkinterDnD
except Exception:  # drag and drop is optional
    TkinterDnD = None
    DND_FILES = None

VERSION = "1.0.0"

# Palette
BG = "#F3F4F6"
PANEL = "#FFFFFF"
BORDER = "#E1E4E8"
TEXT = "#1B1F24"
MUTED = "#5F6874"
ACCENT = "#0E7C66"
ACCENT_DARK = "#0A5F4E"
ACCENT_SOFT = "#E2F1EC"
HEADER = "#12212B"
HEADER_TEXT = "#9FB2BF"
STATUS_COLORS = {
    "pending": "#6B7280",
    "converting": "#0B5CAD",
    "ok": TEXT,
    "skipped": "#8A6100",
    "error": "#C62828",
    "cancelled": "#8A6100",
}

# Choices: stored as codes, shown with translated labels
SEP_LABELS = {"auto": "sep_auto", ",": "sep_comma", ";": "sep_semicolon", "\t": "sep_tab", "|": "sep_pipe"}
ENC_LABELS = {"auto": "enc_auto", "utf-8": "enc_utf8", "cp1252": "enc_cp1252", "latin-1": "enc_latin1",
              "utf-16": "enc_utf16"}
DEC_LABELS = {"auto": "dec_auto", ".": "dec_point", ",": "dec_comma"}
COMP_LABELS = {"snappy": "comp_snappy", "zstd": "comp_zstd", "gzip": "comp_gzip", "none": "comp_none"}
SPLIT_LABELS = {"rows": "split_rows", "mb": "split_mb"}

ICON = (
    "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"
)


# --------------------------------------------------------------------------- #
#  Helpers
# --------------------------------------------------------------------------- #
SCALE = 1.0   # screen scaling factor (125 %, 150 %… on Windows); computed at start-up


def px(n: float) -> int:
    """Converts "design" pixels (100 % scaling) to real pixels."""
    return int(round(n * SCALE))


def compute_scale(root: tk.Misc) -> float:
    global SCALE
    try:
        SCALE = max(1.0, min(root.winfo_fpixels("1i") / 96.0, 3.0))
    except tk.TclError:
        SCALE = 1.0
    return SCALE


def type_label(kind: pa.DataType) -> str:
    if pa.types.is_integer(kind):
        return t("type_int")
    if pa.types.is_floating(kind) or pa.types.is_decimal(kind):
        return t("type_float")
    if pa.types.is_boolean(kind):
        return t("type_bool")
    if pa.types.is_timestamp(kind):
        return t("type_timestamp")
    if pa.types.is_date(kind):
        return t("type_date")
    if pa.types.is_time(kind):
        return t("type_time")
    if pa.types.is_string(kind) or pa.types.is_large_string(kind):
        return t("type_string")
    if pa.types.is_null(kind):
        return t("type_null")
    return str(kind)


def value_text(v) -> str:
    if v is None:
        return ""
    if isinstance(v, float):
        return f"{v:.10g}"
    if isinstance(v, dt.datetime):
        return v.strftime("%Y-%m-%d %H:%M:%S") if (v.hour or v.minute or v.second) else v.strftime("%Y-%m-%d")
    if isinstance(v, dt.date):
        return v.isoformat()
    if isinstance(v, bytes):
        return v.decode("latin-1", errors="replace")
    s = str(v).replace("\r\n", " ↵ ").replace("\n", " ↵ ")
    return s if len(s) <= 120 else s[:117] + "…"


def open_in_file_manager(path: Path) -> None:
    try:
        if sys.platform.startswith("win"):
            os.startfile(str(path))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])
    except Exception as e:  # noqa: BLE001
        messagebox.showerror(t("app_title"), t("dlg_open_folder_failed", error=str(e)))


def pick_fonts(root: tk.Misc) -> tuple[str, str]:
    available = set(tkfont.families(root))
    if sys.platform.startswith("win"):
        preferred, mono = ["Segoe UI"], ["Cascadia Mono", "Consolas"]
    elif sys.platform == "darwin":
        preferred, mono = [".AppleSystemUIFont", "Helvetica Neue"], ["Menlo", "SF Mono"]
    else:
        preferred, mono = ["Inter", "Noto Sans", "Ubuntu", "Cantarell", "DejaVu Sans"], ["DejaVu Sans Mono", "Noto Sans Mono"]
    family = next((f for f in preferred if f in available), tkfont.nametofont("TkDefaultFont").actual("family"))
    mono_family = next((f for f in mono if f in available), tkfont.nametofont("TkFixedFont").actual("family"))
    return family, mono_family


class ScrollPanel(ttk.Frame):
    """Column with a vertical scroll bar (for small screens)."""

    def __init__(self, parent, **kw):
        super().__init__(parent, **kw)
        self.canvas = tk.Canvas(self, bg=BG, highlightthickness=0, borderwidth=0)
        self.bar = ttk.Scrollbar(self, orient="vertical", command=self.canvas.yview)
        self.inner = ttk.Frame(self.canvas, style="Background.TFrame")
        self._window = self.canvas.create_window((0, 0), window=self.inner, anchor="nw")
        self.canvas.configure(yscrollcommand=self.bar.set)
        self.canvas.grid(row=0, column=0, sticky="nsew")
        self.bar.grid(row=0, column=1, sticky="ns")
        self.rowconfigure(0, weight=1)
        self.columnconfigure(0, weight=1)
        self.inner.bind("<Configure>", self._fit)
        self.canvas.bind("<Configure>", self._on_resize)
        self.canvas.bind("<Enter>", lambda e: self._wheel(True))
        self.canvas.bind("<Leave>", lambda e: self._wheel(False))

    def _on_resize(self, e):
        self.canvas.itemconfigure(self._window, width=e.width)
        self._fit()

    def _fit(self, _e=None):
        self.canvas.configure(scrollregion=self.canvas.bbox("all"))
        if self.inner.winfo_reqheight() > self.canvas.winfo_height():
            self.bar.grid()
        else:
            self.bar.grid_remove()
            self.canvas.yview_moveto(0)

    def _wheel(self, on: bool):
        if on:
            self.canvas.bind_all("<MouseWheel>", lambda e: self._scroll(-1 if e.delta > 0 else 1))
            self.canvas.bind_all("<Button-4>", lambda e: self._scroll(-1))
            self.canvas.bind_all("<Button-5>", lambda e: self._scroll(1))
        else:
            self.canvas.unbind_all("<MouseWheel>")
            self.canvas.unbind_all("<Button-4>")
            self.canvas.unbind_all("<Button-5>")

    def _scroll(self, step):
        if self.inner.winfo_reqheight() > self.canvas.winfo_height():
            self.canvas.yview_scroll(step * 2, "units")


class ChoiceBox(ttk.Combobox):
    """Read-only combobox that shows translated labels and stores a code in ``variable``."""

    def __init__(self, parent, variable: tk.StringVar, labels: dict[str, str], **kw):
        self.codes = list(labels)
        self.variable = variable
        super().__init__(parent, values=[t(labels[c]) for c in self.codes], state="readonly", **kw)
        self._show()
        self.bind("<<ComboboxSelected>>", lambda e: variable.set(self.codes[self.current()]))
        self._trace = variable.trace_add("write", lambda *_: self._show())
        self.bind("<Destroy>", lambda e: self._untrace(), add="+")

    def _show(self):
        code = self.variable.get()
        self.current(self.codes.index(code) if code in self.codes else 0)

    def _untrace(self):
        try:
            self.variable.trace_remove("write", self._trace)
        except tk.TclError:
            pass


def dnd_available(config: dict) -> bool:
    """
    Drag and drop uses a native library (tkdnd). On some rare system
    combinations it can abort the process while loading, so the first time it
    is tried in a separate process and the result is remembered.
    """
    if TkinterDnD is None:
        return False
    if getattr(sys, "frozen", False):          # packaged executable: already tested when built
        return True
    key = f"{sys.executable}|{tk.TkVersion}"
    tested = config.setdefault("dnd_tested", {})
    if key not in tested:
        code = ("from tkinterdnd2 import TkinterDnD\n"
                "r = TkinterDnD.Tk(); r.withdraw(); r.update(); r.destroy()")
        try:
            flags = 0x08000000 if sys.platform.startswith("win") else 0   # no console window
            res = subprocess.run([sys.executable, "-c", code], capture_output=True, timeout=30, creationflags=flags)
            tested[key] = res.returncode == 0
        except Exception:  # noqa: BLE001
            tested[key] = False
        save_config(config)
    return bool(tested[key])


# --------------------------------------------------------------------------- #
#  Application
# --------------------------------------------------------------------------- #
class App:
    def __init__(self, root: tk.Tk, config: dict | None = None):
        self.root = root
        compute_scale(root)
        self.queue: queue.Queue = queue.Queue()
        self.cancel_event = threading.Event()
        self.thread: threading.Thread | None = None
        self.sources: list[Path] = []
        self.jobs: list[tuple[Path, Path]] = []
        self.results: dict[int, engine.Result] = {}
        self.sizes: list[int] = []
        self.done_bytes = 0
        self.preview_token = 0
        self.last_target: Path | None = None
        self.combined_info: tuple[int, int] | None = None
        self.log_entries: list[tuple[str, object, str]] = []
        self.status: tuple[str, dict] = ("bar_start", {})
        self.started = 0.0
        self._preview_task = None
        self._controls: list[tk.Widget] = []
        self.config = config if config is not None else read_config()
        self.dnd = False

        self._styles()
        self._variables()
        self._build()
        self._register_dnd()
        self._update_dependent()
        root.bind("<Control-o>", lambda e: self._choose_files())
        root.bind("<Control-Return>", lambda e: self._convert())
        self.root.after(80, self._poll_queue)
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

    # ----------------------------------------------------------------- styles
    def _styles(self):
        r = self.root
        family, mono = pick_fonts(r)
        self.f = (family, 10)
        self.f_bold = (family, 10, "bold")
        self.f_small = (family, 9)
        self.f_title = (family, 17, "bold")
        self.f_section = (family, 11, "bold")
        self.f_mono = (mono, 9)
        for name in ("TkDefaultFont", "TkTextFont", "TkMenuFont", "TkHeadingFont"):
            try:
                tkfont.nametofont(name).configure(family=family, size=10)
            except tk.TclError:
                pass

        r.configure(bg=BG)
        st = ttk.Style(r)
        st.theme_use("clam")
        st.configure(".", background=BG, foreground=TEXT, font=self.f, bordercolor=BORDER,
                     lightcolor=PANEL, darkcolor=BORDER, troughcolor="#E7E9ED", focuscolor=ACCENT,
                     selectbackground=ACCENT_SOFT, selectforeground=TEXT, insertcolor=TEXT)
        st.configure("Background.TFrame", background=BG)
        st.configure("Card.TFrame", background=PANEL, relief="solid", borderwidth=1, bordercolor=BORDER)
        st.configure("Inner.TFrame", background=PANEL)
        st.configure("Header.TFrame", background=HEADER)
        st.configure("Footer.TFrame", background=PANEL)
        st.configure("TLabel", background=PANEL, foreground=TEXT)
        st.configure("Muted.TLabel", background=PANEL, foreground=MUTED, font=self.f_small)
        st.configure("Section.TLabel", background=PANEL, foreground=TEXT, font=self.f_section)
        st.configure("Number.TLabel", background=ACCENT_SOFT, foreground=ACCENT, font=self.f_bold,
                     anchor="center", padding=(7, 1))
        st.configure("Title.TLabel", background=HEADER, foreground="#FFFFFF", font=self.f_title)
        st.configure("Subtitle.TLabel", background=HEADER, foreground=HEADER_TEXT)
        st.configure("Badge.TLabel", background="#1D3442", foreground="#BFE6DA", font=self.f_small, padding=(10, 4))
        st.configure("Status.TLabel", background=PANEL, foreground=MUTED)

        st.configure("TButton", background=PANEL, foreground=TEXT, padding=(px(12), px(6)), bordercolor="#CDD1D7",
                     lightcolor=PANEL, darkcolor="#CDD1D7", focusthickness=0)
        st.map("TButton", background=[("disabled", "#F4F5F7"), ("pressed", "#E4E7EB"), ("active", "#EEF0F3")],
               foreground=[("disabled", "#A0A6AE")])
        st.configure("Accent.TButton", background=ACCENT, foreground="#FFFFFF", bordercolor=ACCENT,
                     lightcolor=ACCENT, darkcolor=ACCENT, padding=(px(22), px(9)), font=self.f_bold)
        st.map("Accent.TButton",
               background=[("disabled", "#A9CBC2"), ("pressed", ACCENT_DARK), ("active", ACCENT_DARK)],
               bordercolor=[("disabled", "#A9CBC2"), ("active", ACCENT_DARK)],
               lightcolor=[("disabled", "#A9CBC2"), ("active", ACCENT_DARK)],
               darkcolor=[("disabled", "#A9CBC2"), ("active", ACCENT_DARK)],
               foreground=[("disabled", "#F2F7F5")])
        st.configure("Lang.TRadiobutton", background=HEADER, foreground=HEADER_TEXT, font=self.f_bold,
                     padding=(px(9), px(3)), indicatorrelief="flat", indicatormargin=0, indicatordiameter=0,
                     borderwidth=1, relief="flat")
        st.layout("Lang.TRadiobutton", [("Radiobutton.padding", {"sticky": "nswe", "children": [
            ("Radiobutton.label", {"sticky": "nswe"})]})])
        st.map("Lang.TRadiobutton", background=[("selected", ACCENT), ("active", "#1D3442")],
               foreground=[("selected", "#FFFFFF"), ("disabled", "#5E6E79")])

        for w in ("TCheckbutton", "TRadiobutton"):
            st.configure(w, background=PANEL, foreground=TEXT, indicatorbackground=PANEL,
                         indicatorforeground="#FFFFFF", upperbordercolor="#9AA2AC", lowerbordercolor="#9AA2AC",
                         indicatormargin=(0, 2, 6, 2), padding=(0, 3))
            st.map(w, background=[("active", PANEL)],
                   indicatorbackground=[("disabled", "selected", "#A9BDB7"), ("disabled", "#EEF0F2"),
                                        ("selected", ACCENT), ("pressed", ACCENT_SOFT)],
                   upperbordercolor=[("selected", ACCENT)], lowerbordercolor=[("selected", ACCENT)],
                   foreground=[("disabled", "#A0A6AE")])

        st.configure("TEntry", fieldbackground=PANEL, padding=(6, 5), bordercolor="#CDD1D7",
                     lightcolor="#CDD1D7", darkcolor="#CDD1D7")
        st.map("TEntry", bordercolor=[("focus", ACCENT)], lightcolor=[("focus", ACCENT)],
               fieldbackground=[("disabled", "#F4F5F7"), ("readonly", "#F7F8FA")], foreground=[("disabled", "#A0A6AE")])
        st.configure("TCombobox", fieldbackground=PANEL, background=PANEL, padding=(px(6), px(4)), arrowsize=px(13),
                     bordercolor="#CDD1D7", lightcolor="#CDD1D7", darkcolor="#CDD1D7", arrowcolor=MUTED)
        st.map("TCombobox", fieldbackground=[("readonly", PANEL), ("disabled", "#F4F5F7")],
               selectbackground=[("readonly", PANEL)], selectforeground=[("readonly", TEXT)],
               bordercolor=[("focus", ACCENT)], foreground=[("disabled", "#A0A6AE")])
        r.option_add("*TCombobox*Listbox.font", self.f)
        r.option_add("*TCombobox*Listbox.selectBackground", ACCENT_SOFT)
        r.option_add("*TCombobox*Listbox.selectForeground", TEXT)

        st.configure("Treeview", background=PANEL, fieldbackground=PANEL, foreground=TEXT, rowheight=px(27),
                     bordercolor=BORDER, lightcolor=BORDER, darkcolor=BORDER, borderwidth=0)
        st.configure("Treeview.Heading", background="#F2F4F6", foreground=MUTED, font=(self.f[0], 9, "bold"),
                     relief="flat", padding=(8, 6), bordercolor=BORDER, lightcolor="#F2F4F6", darkcolor=BORDER)
        st.map("Treeview.Heading", background=[("active", "#E9ECEF")])
        st.map("Treeview", background=[("selected", ACCENT_SOFT)], foreground=[("selected", TEXT)])
        st.configure("Data.Treeview", font=self.f_mono, rowheight=px(24))

        st.configure("TNotebook", background=BG, borderwidth=0, tabmargins=(0, 0, 0, 0))
        st.configure("TNotebook.Tab", background=BG, foreground=MUTED, padding=(px(18), px(8)), borderwidth=0,
                     bordercolor=BG, lightcolor=BG, font=self.f_bold)
        st.map("TNotebook.Tab", background=[("selected", PANEL), ("active", "#E9EBEE")],
               foreground=[("selected", ACCENT)], lightcolor=[("selected", PANEL)],
               bordercolor=[("selected", BORDER)])
        st.configure("Horizontal.TProgressbar", troughcolor="#E5E8EB", background=ACCENT, bordercolor="#E5E8EB",
                     lightcolor=ACCENT, darkcolor=ACCENT, thickness=px(8))
        st.configure("TScrollbar", background="#E3E6EA", troughcolor=PANEL, bordercolor=PANEL,
                     arrowcolor=MUTED, lightcolor="#E3E6EA", darkcolor="#E3E6EA")
        st.configure("TPanedwindow", background=BORDER)

    # -------------------------------------------------------------- variables
    def _variables(self):
        c = self.config.get("options", {})

        def choice(key, labels, default):
            value = c.get(key, default)
            return tk.StringVar(value=value if value in labels else default)

        self.v_language = tk.StringVar(value=i18n.get_language())
        self.v_recursive = tk.BooleanVar(value=c.get("recursive", True))
        self.v_target_mode = tk.StringVar(value=c.get("target_mode", "next_to"))
        self.v_out_dir = tk.StringVar(value=c.get("out_dir", ""))
        self.v_keep_structure = tk.BooleanVar(value=c.get("keep_structure", True))
        self.v_overwrite = tk.BooleanVar(value=c.get("overwrite", False))
        self.v_sep = choice("sep", SEP_LABELS, "auto")
        self.v_enc = choice("enc", ENC_LABELS, "auto")
        self.v_dec = choice("dec", DEC_LABELS, "auto")
        self.v_header = tk.BooleanVar(value=c.get("header", True))
        self.v_dmy = tk.BooleanVar(value=c.get("dmy", True))
        self.v_all_text = tk.BooleanVar(value=c.get("all_text", False))
        self.v_skip_bad = tk.BooleanVar(value=c.get("skip_bad", False))
        self.v_comp = choice("comp", COMP_LABELS, "snappy")
        self.v_output_mode = tk.StringVar(value=c.get("output_mode", "per_file"))
        self.v_combined_name = tk.StringVar(value=c.get("combined_name", "combined.parquet"))
        self.v_source_col = tk.BooleanVar(value=c.get("source_col", True))
        self.v_split = tk.BooleanVar(value=c.get("split", False))
        self.v_split_mode = choice("split_mode", SPLIT_LABELS, "rows")
        self.v_split_value = tk.StringVar(value=c.get("split_value", "1000000"))
        self.v_status = tk.StringVar()
        self.v_preview_file = tk.StringVar()
        self.v_preview_info = tk.StringVar(value="")
        for v in (self.v_sep, self.v_enc, self.v_dec, self.v_header, self.v_dmy, self.v_all_text, self.v_skip_bad):
            v.trace_add("write", lambda *_: self._schedule_preview())
        for v in (self.v_target_mode, self.v_output_mode, self.v_split):
            v.trace_add("write", lambda *_: self._update_dependent())
        self.v_split_mode.trace_add("write", lambda *_: self._on_split_mode())
        self.v_recursive.trace_add("write", lambda *_: self._rescan())

    def options(self) -> engine.Options:
        sep = self.v_sep.get()
        return engine.Options(
            separator=None if sep == "auto" else sep,
            encoding=self.v_enc.get(),
            header=self.v_header.get(),
            decimal=self.v_dec.get(),
            dmy_dates=self.v_dmy.get(),
            all_text=self.v_all_text.get(),
            skip_bad_rows=self.v_skip_bad.get(),
            compression=self.v_comp.get(),
            recursive=self.v_recursive.get(),
            overwrite=self.v_overwrite.get(),
            combine=self.v_output_mode.get() == "combine",
            combined_name=self.v_combined_name.get(),
            source_column=self.v_source_col.get(),
            keep_structure=self.v_keep_structure.get(),
            split_mode=self.v_split_mode.get() if self.v_split.get() else None,
            split_value=self._split_value() or 0,
        )

    def _split_value(self) -> float | None:
        raw = self.v_split_value.get().strip()
        if self.v_split_mode.get() == "rows":
            raw = raw.replace(".", "").replace(",", "")         # 1.000.000 or 1,000,000
        else:
            raw = raw.replace(",", ".")
        try:
            v = float(raw)
        except ValueError:
            return None
        return v if v > 0 else None

    def _on_split_mode(self):
        # when the unit changes, propose a sensible value if it had not been edited
        current = self.v_split_value.get().strip()
        if self.v_split_mode.get() == "rows" and current in ("", "128"):
            self.v_split_value.set("1000000")
        elif self.v_split_mode.get() == "mb" and current in ("", "1000000", "1.000.000", "1,000,000"):
            self.v_split_value.set("128")

    # -------------------------------------------------------------- interface
    def _build(self):
        r = self.root
        r.title(t("app_title"))
        try:
            self._icon = tk.PhotoImage(data=ICON)
            r.iconphoto(True, self._icon)
        except tk.TclError:
            pass
        r.columnconfigure(0, weight=1)
        r.rowconfigure(1, weight=1)

        # Header
        head = ttk.Frame(r, style="Header.TFrame", padding=(px(22), px(14)))
        head.grid(row=0, column=0, sticky="ew")
        head.columnconfigure(1, weight=1)
        try:
            self._logo = tk.PhotoImage(data=ICON).subsample(2, 2)
            ttk.Label(head, image=self._logo, style="Title.TLabel").grid(row=0, column=0, rowspan=2, padx=(0, 12))
        except tk.TclError:
            pass
        ttk.Label(head, text=t("app_title"), style="Title.TLabel").grid(row=0, column=1, sticky="w")
        ttk.Label(head, text=t("app_subtitle_desktop"), style="Subtitle.TLabel").grid(row=1, column=1, sticky="w")
        ttk.Label(head, text=t("app_badge_desktop"), style="Badge.TLabel").grid(row=0, column=2, rowspan=2,
                                                                              sticky="e", padx=(0, 14))
        langs = ttk.Frame(head, style="Header.TFrame")
        langs.grid(row=0, column=3, rowspan=2, sticky="e")
        for code in i18n.LANGUAGES:
            b = ttk.Radiobutton(langs, text=code.upper(), value=code, variable=self.v_language,
                                style="Lang.TRadiobutton", command=lambda c=code: self._switch_language(c))
            b.pack(side="left")
            self._controls.append(b)

        # Body
        body = ttk.Frame(r, style="Background.TFrame", padding=(px(16), px(14), px(16), px(10)))
        body.grid(row=1, column=0, sticky="nsew")
        body.columnconfigure(1, weight=1)
        body.rowconfigure(0, weight=1)

        left = ScrollPanel(body, style="Background.TFrame", width=px(392))
        left.grid(row=0, column=0, sticky="nsw", padx=(0, px(14)))
        left.grid_propagate(False)
        col = left.inner
        col.columnconfigure(0, weight=1)
        self._source_card(col).grid(row=0, column=0, sticky="ew", pady=(0, 10))
        self._target_card(col).grid(row=1, column=0, sticky="ew", pady=(0, 10))
        self._output_card(col).grid(row=2, column=0, sticky="ew", pady=(0, 4))
        # with large screen scaling the content may need more width than planned
        col.update_idletasks()
        left.configure(width=max(px(392), col.winfo_reqwidth() + px(18)))

        self.tabs = ttk.Notebook(body)
        self.tabs.grid(row=0, column=1, sticky="nsew")
        self.tabs.add(self._files_tab(), text=t("tab_files"))
        self.tabs.add(self._preview_tab(), text=t("tab_preview"))
        self.tabs.add(self._log_tab(), text=t("tab_log"))

        # Footer
        foot = ttk.Frame(r, style="Footer.TFrame", padding=(px(18), px(12)))
        foot.grid(row=2, column=0, sticky="ew")
        tk.Frame(r, bg=BORDER, height=1).grid(row=2, column=0, sticky="new")
        foot.columnconfigure(0, weight=1)
        info = ttk.Frame(foot, style="Footer.TFrame")
        info.grid(row=0, column=0, sticky="ew", padx=(0, 18))
        info.columnconfigure(0, weight=1)
        ttk.Label(info, textvariable=self.v_status, style="Status.TLabel").grid(row=0, column=0, sticky="w")
        self.progress = ttk.Progressbar(info, mode="determinate", maximum=1000)
        self.progress.grid(row=1, column=0, sticky="ew", pady=(6, 0))
        self.b_open = ttk.Button(foot, text=t("btn_open_dest"), command=self._open_target, state="disabled")
        self.b_open.grid(row=0, column=1, padx=(0, 8))
        self.b_cancel = ttk.Button(foot, text=t("btn_cancel"), command=self._cancel, state="disabled")
        self.b_cancel.grid(row=0, column=2, padx=(0, 8))
        self.b_convert = ttk.Button(foot, text=t("btn_convert"), style="Accent.TButton",
                                    command=self._convert, state="disabled")
        self.b_convert.grid(row=0, column=3)
        self._draw_zone()
        self._render_status()

    def _register_dnd(self):
        if DND_FILES is not None and hasattr(self.root, "drop_target_register"):
            try:
                self.root.drop_target_register(DND_FILES)
                self.root.dnd_bind("<<Drop>>", self._on_drop)
                self.dnd = True
            except Exception:  # noqa: BLE001
                self.dnd = False
        self._draw_zone()

    def _card(self, parent, number: str, title: str):
        frame = ttk.Frame(parent, style="Card.TFrame", padding=(px(16), px(12), px(16), px(12)))
        frame.columnconfigure(0, weight=1)
        head = ttk.Frame(frame, style="Inner.TFrame")
        head.grid(row=0, column=0, sticky="ew", pady=(0, 10))
        ttk.Label(head, text=number, style="Number.TLabel").pack(side="left", padx=(0, 9))
        ttk.Label(head, text=title, style="Section.TLabel").pack(side="left")
        inner = ttk.Frame(frame, style="Inner.TFrame")
        inner.grid(row=1, column=0, sticky="ew")
        inner.columnconfigure(0, weight=1)
        return frame, inner

    def _reg(self, w):
        self._controls.append(w)
        return w

    def _source_card(self, parent):
        frame, c = self._card(parent, "1", t("step_source"))
        buttons = ttk.Frame(c, style="Inner.TFrame")
        buttons.grid(row=0, column=0, sticky="ew")
        buttons.columnconfigure((0, 1), weight=1, uniform="b")
        self._reg(ttk.Button(buttons, text=t("btn_choose_files"), command=self._choose_files)).grid(
            row=0, column=0, sticky="ew", padx=(0, 4))
        self._reg(ttk.Button(buttons, text=t("btn_choose_folder"), command=self._choose_folder)).grid(
            row=0, column=1, sticky="ew", padx=(4, 0))
        self.zone = tk.Canvas(c, height=px(80), bg=PANEL, highlightthickness=0, cursor="hand2")
        self.zone.grid(row=1, column=0, sticky="ew", pady=(10, 6))
        self.zone.bind("<Configure>", lambda e: self._draw_zone())
        self.zone.bind("<Button-1>", lambda e: self._choose_folder())
        self._reg(ttk.Checkbutton(c, text=t("opt_subfolders"), variable=self.v_recursive)).grid(
            row=2, column=0, sticky="w")
        ttk.Label(c, style="Muted.TLabel", wraplength=px(340), justify="left", text=t("src_hint_desktop")).grid(
            row=3, column=0, sticky="w", pady=(4, 0))
        return frame

    def _draw_zone(self):
        z = getattr(self, "zone", None)
        if z is None or not z.winfo_exists():
            return
        z.delete("all")
        w, h = max(z.winfo_width(), 300), int(z["height"])
        z.create_rectangle(2, 2, w - 2, h - 2, outline="#B9C9C4", dash=(5, 4), width=1, fill="#FAFCFB")
        if self.jobs:
            total = sum(self.sizes)
            n = len(self.jobs)
            if len(self.sources) == 1 and self.sources[0].is_dir():
                line1 = self._shorten(str(self.sources[0]), 48)
            elif all(f.is_dir() for f in self.sources):
                line1 = t("zone_folders", n=len(self.sources))
            elif n == 1:
                line1 = self._shorten(self.jobs[0][0].name, 48)
            else:
                line1 = t("zone_files", n=n)
            z.create_text(w / 2, h / 2 - 12, text=line1, font=self.f_bold, fill=TEXT)
            z.create_text(w / 2, h / 2 + 12, font=self.f_small, fill=ACCENT, text=t("zone_count", n=n, size=total))
        elif self.sources:
            z.create_text(w / 2, h / 2 - 10, text=t("zone_none"), font=self.f_bold, fill="#8A6100")
            z.create_text(w / 2, h / 2 + 12, text=t("zone_none_hint"), font=self.f_small, fill=MUTED)
        else:
            main = t("zone_drop") if self.dnd else t("zone_click")
            z.create_text(w / 2, h / 2 - 10, text=main, font=self.f_bold, fill=TEXT)
            z.create_text(w / 2, h / 2 + 12, text=t("zone_types"), font=self.f_small, fill=MUTED)

    @staticmethod
    def _shorten(s: str, n: int) -> str:
        return s if len(s) <= n else "…" + s[-(n - 1):]

    def _target_card(self, parent):
        frame, c = self._card(parent, "2", t("step_target"))
        self._reg(ttk.Radiobutton(c, text=t("dst_next_to"), value="next_to",
                                  variable=self.v_target_mode)).grid(row=0, column=0, sticky="w")
        self._reg(ttk.Radiobutton(c, text=t("dst_other_folder"), value="folder",
                                  variable=self.v_target_mode)).grid(row=1, column=0, sticky="w")
        row = ttk.Frame(c, style="Inner.TFrame")
        row.grid(row=2, column=0, sticky="ew", padx=(24, 0), pady=(2, 4))
        row.columnconfigure(0, weight=1)
        self.e_out_dir = self._reg(ttk.Entry(row, textvariable=self.v_out_dir))
        self.e_out_dir.grid(row=0, column=0, sticky="ew")
        self.b_out_dir = self._reg(ttk.Button(row, text=t("btn_browse"), command=self._choose_out_dir))
        self.b_out_dir.grid(row=0, column=1, padx=(6, 0))
        self.c_keep_structure = self._reg(ttk.Checkbutton(c, text=t("opt_keep_structure"),
                                                          variable=self.v_keep_structure))
        self.c_keep_structure.grid(row=3, column=0, sticky="w", padx=(24, 0))
        self._reg(ttk.Checkbutton(c, text=t("opt_overwrite"), variable=self.v_overwrite)).grid(
            row=4, column=0, sticky="w", pady=(4, 0))
        return frame

    def _output_card(self, parent):
        frame, c = self._card(parent, "3", t("step_output"))
        grid = ttk.Frame(c, style="Inner.TFrame")
        grid.grid(row=0, column=0, sticky="ew", pady=(0, 6))
        grid.columnconfigure(1, weight=1)
        ttk.Label(grid, text=t("lbl_compression")).grid(row=0, column=0, sticky="w", padx=(0, 12))
        self._reg(ChoiceBox(grid, self.v_comp, COMP_LABELS)).grid(row=0, column=1, sticky="ew")
        self._reg(ttk.Radiobutton(c, text=t("out_per_file"), value="per_file",
                                  variable=self.v_output_mode)).grid(row=1, column=0, sticky="w")
        self._reg(ttk.Radiobutton(c, text=t("out_combine"), value="combine",
                                  variable=self.v_output_mode)).grid(row=2, column=0, sticky="w")
        self.e_combined_name = self._reg(ttk.Entry(c, textvariable=self.v_combined_name))
        self.e_combined_name.grid(row=3, column=0, sticky="ew", padx=(24, 0), pady=(2, 2))
        self.c_source_col = self._reg(ttk.Checkbutton(c, text=t("opt_source_column", column=engine.SOURCE_COLUMN),
                                                      variable=self.v_source_col))
        self.c_source_col.grid(row=4, column=0, sticky="w", padx=(24, 0))
        ttk.Separator(c).grid(row=5, column=0, sticky="ew", pady=(8, 6))
        row = ttk.Frame(c, style="Inner.TFrame")
        row.grid(row=6, column=0, sticky="ew")
        self._reg(ttk.Checkbutton(row, text=t("opt_split"), variable=self.v_split)).grid(row=0, column=0, sticky="w")
        self.e_split = self._reg(ttk.Entry(row, textvariable=self.v_split_value, width=9, justify="right"))
        self.e_split.grid(row=0, column=1, sticky="w", padx=(6, 0))
        self.cb_split = self._reg(ChoiceBox(row, self.v_split_mode, SPLIT_LABELS, width=11))
        self.cb_split.grid(row=0, column=2, sticky="w", padx=(6, 0))
        self.l_split = ttk.Label(c, style="Muted.TLabel", text=t("split_hint_desktop"))
        self.l_split.grid(row=7, column=0, sticky="w", padx=(24, 0), pady=(2, 0))
        return frame

    def _files_tab(self):
        p = ttk.Frame(self.tabs, style="Inner.TFrame", padding=(0, 0, 0, 0))
        p.columnconfigure(0, weight=1)
        p.rowconfigure(0, weight=1)
        columns = (("file", t("col_file"), 200, "w"), ("size", t("col_size"), 78, "e"),
                   ("status", t("col_status"), 120, "w"), ("rows", t("col_rows"), 90, "e"),
                   ("cols", t("col_cols"), 58, "e"), ("parquet", t("col_parquet"), 136, "e"),
                   ("time", t("col_time"), 68, "e"))
        self._fixed_widths = sum(px(c[2]) for c in columns[1:])
        self.table = ttk.Treeview(p, columns=[c[0] for c in columns], show="headings", selectmode="browse")
        for key, title, width, anchor in columns:
            self.table.heading(key, text=title, anchor=anchor)
            self.table.column(key, width=px(width), minwidth=px(50), anchor=anchor, stretch=False)
        for status, color in STATUS_COLORS.items():
            self.table.tag_configure(status, foreground=color)
        self.table.tag_configure("odd", background="#FAFBFC")
        sb = ttk.Scrollbar(p, orient="vertical", command=self.table.yview)
        self.table.configure(yscrollcommand=sb.set)
        self.table.grid(row=0, column=0, sticky="nsew")
        sb.grid(row=0, column=1, sticky="ns")
        self.table.bind("<<TreeviewSelect>>", self._on_select)
        self.table.bind("<Double-1>", self._preview_selected)
        # the "File" column takes the remaining width, so nothing is cut on the right
        self.table.bind("<Configure>", lambda e: self.table.column(
            "file", width=max(px(120), e.width - self._fixed_widths - px(6))))

        self.empty = ttk.Label(p, style="Muted.TLabel", justify="center", anchor="center",
                               text=t("files_empty_desktop"), font=self.f)
        self.empty.place(relx=0.5, rely=0.5, anchor="center")

        tk.Frame(p, bg=BORDER, height=1).grid(row=1, column=0, columnspan=2, sticky="ew")
        self.detail = tk.Text(p, height=4, wrap="word", relief="flat", bg="#FAFBFC", fg=TEXT, font=self.f_small,
                              padx=14, pady=10, borderwidth=0, highlightthickness=0, cursor="arrow")
        self.detail.grid(row=2, column=0, columnspan=2, sticky="ew")
        self.detail.tag_configure("bold", font=(self.f[0], 9, "bold"))
        self.detail.tag_configure("error", foreground=STATUS_COLORS["error"])
        self.detail.tag_configure("warning", foreground=STATUS_COLORS["skipped"])
        self._write_detail([(t("detail_placeholder"), "")])
        return p

    def _preview_tab(self):
        p = ttk.Frame(self.tabs, style="Inner.TFrame")
        p.columnconfigure(0, weight=1)
        p.rowconfigure(1, weight=1)
        bar = ttk.Frame(p, style="Inner.TFrame", padding=(14, 10, 14, 6))
        bar.grid(row=0, column=0, sticky="ew")
        bar.columnconfigure(1, weight=1)
        ttk.Label(bar, text=t("lbl_file")).grid(row=0, column=0, padx=(0, 10))
        self.cb_preview = ttk.Combobox(bar, textvariable=self.v_preview_file, state="readonly")
        self.cb_preview.grid(row=0, column=1, sticky="ew")
        self.cb_preview.bind("<<ComboboxSelected>>", lambda e: self._load_preview())
        ttk.Button(bar, text=t("btn_refresh"), command=self._load_preview).grid(row=0, column=2, padx=(8, 0))

        reading = ttk.Frame(bar, style="Inner.TFrame")
        reading.grid(row=1, column=0, columnspan=3, sticky="ew", pady=(10, 0))
        for k, (label, var, labels, width) in enumerate(((t("lbl_separator"), self.v_sep, SEP_LABELS, 18),
                                                        (t("lbl_encoding"), self.v_enc, ENC_LABELS, 18),
                                                        (t("lbl_decimal"), self.v_dec, DEC_LABELS, 11))):
            ttk.Label(reading, text=label).grid(row=0, column=2 * k, sticky="w", padx=(0 if k == 0 else 16, 6))
            self._reg(ChoiceBox(reading, var, labels, width=width)).grid(row=0, column=2 * k + 1, sticky="w")
        checks = ttk.Frame(reading, style="Inner.TFrame")
        checks.grid(row=1, column=0, columnspan=6, sticky="w", pady=(6, 0))
        for k, (label, var) in enumerate(((t("opt_header"), self.v_header), (t("opt_dmy"), self.v_dmy),
                                          (t("opt_all_text"), self.v_all_text), (t("opt_skip_bad"), self.v_skip_bad))):
            self._reg(ttk.Checkbutton(checks, text=label, variable=var)).grid(row=0, column=k, sticky="w",
                                                                             padx=(0, 16))
        tk.Frame(bar, bg=BORDER, height=1).grid(row=2, column=0, columnspan=3, sticky="ew", pady=(10, 8))
        ttk.Label(bar, textvariable=self.v_preview_info, style="Muted.TLabel").grid(
            row=3, column=0, columnspan=3, sticky="w")

        panes = ttk.PanedWindow(p, orient="horizontal")
        panes.grid(row=1, column=0, sticky="nsew")
        left = ttk.Frame(panes, style="Inner.TFrame")
        left.columnconfigure(0, weight=1)
        left.rowconfigure(0, weight=1)
        self.data = ttk.Treeview(left, show="headings", style="Data.Treeview")
        sy = ttk.Scrollbar(left, orient="vertical", command=self.data.yview)
        sx = ttk.Scrollbar(left, orient="horizontal", command=self.data.xview)
        self.data.configure(yscrollcommand=sy.set, xscrollcommand=sx.set)
        self.data.grid(row=0, column=0, sticky="nsew")
        sy.grid(row=0, column=1, sticky="ns")
        sx.grid(row=1, column=0, sticky="ew")
        self.data.tag_configure("odd", background="#FAFBFC")

        right = ttk.Frame(panes, style="Inner.TFrame")
        right.columnconfigure(0, weight=1)
        right.rowconfigure(1, weight=1)
        ttk.Label(right, text=t("schema_title"), style="Section.TLabel", padding=(12, 8)).grid(
            row=0, column=0, sticky="w")
        self.schema = ttk.Treeview(right, columns=("col", "type", "arrow"), show="headings")
        for key, title, width in (("col", t("schema_column"), 150), ("type", t("schema_type"), 110),
                                  ("arrow", "Arrow", 90)):
            self.schema.heading(key, text=title, anchor="w")
            self.schema.column(key, width=px(width), minwidth=px(60), anchor="w")
        ss = ttk.Scrollbar(right, orient="vertical", command=self.schema.yview)
        self.schema.configure(yscrollcommand=ss.set)
        self.schema.grid(row=1, column=0, sticky="nsew")
        ss.grid(row=1, column=1, sticky="ns")
        self.schema.tag_configure("text", foreground=MUTED)
        panes.add(left, weight=3)
        panes.add(right, weight=1)
        self.panes = panes
        panes.bind("<Configure>", lambda e: self._fit_panes())
        self.preview_empty = ttk.Label(p, style="Muted.TLabel", text=t("preview_empty"), font=self.f)
        self.preview_empty.place(relx=0.4, rely=0.5, anchor="center")
        return p

    def _log_tab(self):
        p = ttk.Frame(self.tabs, style="Inner.TFrame")
        p.columnconfigure(0, weight=1)
        p.rowconfigure(1, weight=1)
        bar = ttk.Frame(p, style="Inner.TFrame", padding=(14, 8))
        bar.grid(row=0, column=0, columnspan=2, sticky="ew")
        ttk.Button(bar, text=t("btn_export_report"), command=self._export_report).pack(side="right")
        ttk.Button(bar, text=t("btn_clear"), command=self._clear_log).pack(side="right", padx=(0, 8))
        ttk.Label(bar, text=t("log_description"), style="Muted.TLabel").pack(side="left")
        self.log_text = tk.Text(p, wrap="word", relief="flat", bg=PANEL, fg=TEXT, font=self.f_mono, padx=14,
                                pady=8, borderwidth=0, highlightthickness=0, state="disabled")
        sb = ttk.Scrollbar(p, orient="vertical", command=self.log_text.yview)
        self.log_text.configure(yscrollcommand=sb.set)
        self.log_text.grid(row=1, column=0, sticky="nsew")
        sb.grid(row=1, column=1, sticky="ns")
        for level, color in (("ok", STATUS_COLORS["ok"]), ("error", STATUS_COLORS["error"]),
                             ("warning", STATUS_COLORS["skipped"]), ("info", TEXT), ("time", "#9AA1AA")):
            self.log_text.tag_configure(level, foreground=color)
        return p

    # ------------------------------------------------------------- language
    def _switch_language(self, code: str):
        if self._busy() or code == i18n.get_language():
            self.v_language.set(i18n.get_language())
            return
        i18n.set_language(code)
        self.config["language"] = code
        self._save_config()
        tab = self.tabs.index(self.tabs.select())
        selection = self.table.selection()
        preview = self.v_preview_file.get()
        detail_shown = bool(selection)
        for child in self.root.winfo_children():
            child.destroy()
        self._controls = []
        self._build()
        # restore what was on screen, now in the new language
        self._fill_table()
        for i, r in self.results.items():
            self.table.item(str(i), values=self._row_values(i, r.status, r), tags=self._tags(i, r.status))
        names = [self._rel_name(i) for i in range(len(self.jobs))]
        self.cb_preview.configure(values=names)
        if self.jobs:
            self.v_preview_file.set(preview if preview in names else names[0])
            self._load_preview()
        for entry in self.log_entries:
            self._insert_log(*entry)
        if self.results:
            self.progress["value"] = 1000 * self.done_bytes / max(sum(self.sizes), 1)
            self.b_open.configure(state="normal" if any(r.status == "ok" for r in self.results.values()) else "disabled")
        if detail_shown:
            self.table.selection_set(selection)
        self.tabs.select(tab)
        self._update_dependent()

    # ------------------------------------------------------------- source
    def _choose_files(self):
        if self._busy():
            return
        paths = filedialog.askopenfilenames(
            title=t("fd_choose_files"), initialdir=self.config.get("last_source") or Path.home(),
            filetypes=[(t("ft_csv_json"), "*.csv *.tsv *.json *.jsonl *.ndjson *.gz *.CSV *.TSV *.JSON"),
                       ("CSV", "*.csv *.tsv *.CSV *.TSV"), ("JSON", "*.json *.jsonl *.ndjson *.JSON"),
                       (t("ft_all"), "*.*")])
        if paths:
            self.set_sources([Path(x) for x in paths])

    def _choose_folder(self):
        if self._busy():
            return
        path = filedialog.askdirectory(title=t("fd_choose_folder"),
                                       initialdir=self.config.get("last_source") or Path.home())
        if path:
            self.set_sources([Path(path)])

    def _on_drop(self, event):
        if self._busy():
            return
        paths = [Path(x) for x in self.root.tk.splitlist(event.data)]
        if paths:
            self.set_sources(paths)

    def set_sources(self, paths: list[Path]):
        self.sources = paths
        first = paths[0]
        self.config["last_source"] = str(first if first.is_dir() else first.parent)
        self._rescan()

    def _rescan(self):
        if not self.sources or self._busy():
            return
        self.jobs = engine.list_files(self.sources, self.v_recursive.get())
        self.sizes = []
        for f, _ in self.jobs:
            try:
                self.sizes.append(f.stat().st_size)
            except OSError:
                self.sizes.append(0)
        self.results.clear()
        self._fill_table()
        self._draw_zone()
        names = [self._rel_name(i) for i in range(len(self.jobs))]
        self.cb_preview.configure(values=names)
        self.progress["value"] = 0
        if self.jobs:
            self.v_preview_file.set(names[0])
            self._load_preview()
            n = len(self.jobs)
            self._set_status("bar_ready", n=n, size=sum(self.sizes))
            self._log(Msg("log_source", paths=", ".join(str(x) for x in self.sources), n=n), "info")
        else:
            self.v_preview_file.set("")
            self._clear_preview(t("preview_empty"))
            self._set_status("bar_none_found")
        self._update_dependent()

    def _rel_name(self, i: int) -> str:
        file, root = self.jobs[i]
        try:
            return file.relative_to(root).as_posix()
        except ValueError:
            return file.name

    def _fill_table(self):
        self.table.delete(*self.table.get_children())
        for i, _ in enumerate(self.jobs):
            self.table.insert("", "end", iid=str(i), values=self._row_values(i), tags=self._tags(i, "pending"))
        if self.jobs:
            self.empty.place_forget()
        else:
            self.empty.place(relx=0.5, rely=0.5, anchor="center")

    def _tags(self, i, status):
        return (status, "odd") if i % 2 else (status,)

    def _row_values(self, i: int, status: str = "pending", r: engine.Result | None = None, extra: str = ""):
        base = [self._rel_name(i), i18n.fmt_bytes(self.sizes[i])]
        label = t(f"status_{status}") + extra
        if r is None or r.status != "ok":
            return base + [label, "", "", "", i18n.fmt_seconds(r.seconds) if r else ""]
        if r.parquet_bytes and r.parts:
            parquet = t("parquet_in_parts", size=r.parquet_bytes, n=r.parts)
        elif r.parquet_bytes:
            parquet = i18n.fmt_bytes(r.parquet_bytes)
            if r.source_bytes >= 16 * 1024:            # for tiny files the percentage means nothing
                change = (1 - r.parquet_bytes / r.source_bytes) * 100
                parquet += "  (" + (t("pct_down", pct=round(change)) if change >= 0 else
                                    t("pct_up", pct=round(-change))) + ")"
        else:
            parquet = t("parquet_in_combined")
        return base + [label, i18n.fmt_int(r.rows), r.columns, parquet, i18n.fmt_seconds(r.seconds)]

    # ------------------------------------------------------------- target
    def _choose_out_dir(self):
        path = filedialog.askdirectory(title=t("fd_choose_dest"),
                                       initialdir=self.v_out_dir.get() or self.config.get("last_source") or Path.home())
        if path:
            self.v_out_dir.set(path)
            self.v_target_mode.set("folder")

    def _out_dir(self) -> Path | None:
        if self.v_target_mode.get() == "folder":
            return Path(self.v_out_dir.get().strip()) if self.v_out_dir.get().strip() else None
        return None

    def _update_dependent(self):
        if self._busy():
            return
        other = self.v_target_mode.get() == "folder"
        for w in (self.e_out_dir, self.b_out_dir, self.c_keep_structure):
            w.configure(state="normal" if other else "disabled")
        combine = self.v_output_mode.get() == "combine"
        for w in (self.e_combined_name, self.c_source_col):
            w.configure(state="normal" if combine else "disabled")
        split = self.v_split.get()
        self.e_split.configure(state="normal" if split else "disabled")
        self.cb_split.configure(state="readonly" if split else "disabled")
        self.l_split.configure(foreground=MUTED if split else "#A0A6AE")
        self.b_convert.configure(state="normal" if self.jobs else "disabled")

    # ---------------------------------------------------------- preview
    def _schedule_preview(self):
        if self._preview_task:
            self.root.after_cancel(self._preview_task)
        self._preview_task = self.root.after(350, self._load_preview)

    def _load_preview(self):
        self._preview_task = None
        name = self.v_preview_file.get()
        if not name or not self.jobs:
            return
        try:
            i = [self._rel_name(k) for k in range(len(self.jobs))].index(name)
        except ValueError:
            return
        path = self.jobs[i][0]
        self.preview_token += 1
        token = self.preview_token
        self.v_preview_info.set(t("preview_reading"))
        op = self.options()

        def work():
            try:
                table, fmt = engine.preview(path, op)
                self.queue.put(("preview", token, table, fmt, None))
            except Exception as e:  # noqa: BLE001
                self.queue.put(("preview", token, None, None, engine.error_message(e)))

        threading.Thread(target=work, daemon=True).start()

    def _fit_panes(self):
        """Keeps the schema pane readable when the data has many wide columns."""
        try:
            width = self.panes.winfo_width()
            if width > px(600) and width - self.panes.sashpos(0) < px(320):
                self.panes.sashpos(0, width - px(340))
        except tk.TclError:
            pass

    def _clear_preview(self, message: str):
        self.data.delete(*self.data.get_children())
        self.data.configure(columns=())
        self.schema.delete(*self.schema.get_children())
        self.v_preview_info.set("")
        self.preview_empty.configure(text=message)
        self.preview_empty.place(relx=0.4, rely=0.5, anchor="center")

    def _show_preview(self, table: pa.Table | None, fmt, error: Msg | None):
        if error is not None:
            self._clear_preview(t("preview_error", error=str(error)))
            self.preview_empty.configure(foreground=STATUS_COLORS["error"], wraplength=px(520), justify="center")
            return
        self.preview_empty.place_forget()
        self.preview_empty.configure(foreground=MUTED)
        names = table.column_names
        ids = [f"c{k}" for k in range(len(names))]
        self.data.delete(*self.data.get_children())
        self.data.configure(columns=ids)
        rows = table.to_pylist()
        measure = tkfont.Font(font=self.f_mono)
        for k, (cid, n) in enumerate(zip(ids, names)):
            samples = [value_text(r[n]) for r in rows[:50]]
            width = max([measure.measure(n) + 34] + [measure.measure(s) + 22 for s in samples])
            numeric = pa.types.is_integer(table.schema.field(k).type) or pa.types.is_floating(table.schema.field(k).type)
            self.data.heading(cid, text=n, anchor="e" if numeric else "w")
            self.data.column(cid, width=min(max(width, px(70)), px(320)), minwidth=px(50), stretch=False,
                             anchor="e" if numeric else "w")
        for j, r in enumerate(rows):
            self.data.insert("", "end", values=[value_text(r[n]) for n in names], tags=("odd",) if j % 2 else ())
        self.schema.delete(*self.schema.get_children())
        for f in table.schema:
            self.schema.insert("", "end", values=(f.name, type_label(f.type), str(f.type)),
                               tags=("text",) if pa.types.is_string(f.type) or pa.types.is_null(f.type) else ())
        self.root.after_idle(self._fit_panes)
        enc = engine.ENCODING_NAMES.get(fmt.encoding, fmt.encoding)
        if isinstance(fmt, engine.JsonFormat):
            self.v_preview_info.set(t("preview_info_json", format=str(fmt.describe()), encoding=enc,
                                      columns=len(names), rows=table.num_rows))
            return
        self.v_preview_info.set(t("preview_info_csv", separator=engine.separator_name(fmt.separator),
                                  encoding=enc, decimal=t("dec_name_comma" if fmt.decimal == "," else "dec_name_point"),
                                  columns=len(names), rows=table.num_rows))

    # ------------------------------------------------------------- detail
    def _write_detail(self, parts: list[tuple[str, str]]):
        d = self.detail
        d.configure(state="normal")
        d.delete("1.0", "end")
        for text, tag in parts:
            d.insert("end", text, tag)
        d.configure(state="disabled")

    def _on_select(self, _e=None):
        sel = self.table.selection()
        if not sel:
            return
        i = int(sel[0])
        file, _ = self.jobs[i]
        parts = [(t("detail_source") + " ", "bold"), (str(file) + "\n", "")]
        r = self.results.get(i)
        if r is not None:
            if r.target is not None and r.status in ("ok", "skipped"):
                target = str(r.target)
                if r.parts:
                    target = f"{engine.parts_folder(r.target)}  ({t('parts_count', n=r.parts)})"
                parts += [(t("detail_target") + " ", "bold"), (f"{target}\n", "")]
            enc = engine.ENCODING_NAMES.get(r.encoding, r.encoding)
            if r.format is not None and r.format.key != "fmt_csv":
                parts += [(t("detail_read_as") + " ", "bold"), (f"{r.format}, {enc}\n", "")]
            elif r.separator:
                parts += [(t("detail_read_with") + " ", "bold"),
                          (t("detail_csv_reading", separator=engine.separator_name(r.separator),
                             encoding=enc, decimal=t("dec_name_comma" if r.decimal == "," else "dec_name_point"))
                           + "\n", "")]
            if r.messages:
                tag = "error" if r.status == "error" else "warning"
                label = t("detail_note") if r.status == "ok" else t("detail_reason")
                parts += [(label + " ", "bold"), (r.message, tag)]
        self._write_detail(parts)

    def _preview_selected(self, _e=None):
        sel = self.table.selection()
        if sel:
            self.v_preview_file.set(self._rel_name(int(sel[0])))
            self._load_preview()
            self.tabs.select(1)

    # ------------------------------------------------------------ log
    def _log(self, message, level: str = "info"):
        entry = (time.strftime("%H:%M:%S  "), message, level)
        self.log_entries.append(entry)
        self._insert_log(*entry)

    def _insert_log(self, stamp: str, message, level: str):
        self.log_text.configure(state="normal")
        self.log_text.insert("end", stamp, "time")
        self.log_text.insert("end", str(message) + "\n", level)
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def _clear_log(self):
        self.log_entries.clear()
        self.log_text.configure(state="normal")
        self.log_text.delete("1.0", "end")
        self.log_text.configure(state="disabled")

    def _set_status(self, key: str, **params):
        self.status = (key, params)
        self._render_status()

    def _render_status(self):
        key, params = self.status
        self.v_status.set(t(key, **params))

    def _export_report(self):
        if not self.results:
            messagebox.showinfo(t("app_title"), t("dlg_no_results"))
            return
        path = filedialog.asksaveasfilename(
            title=t("fd_save_report"), defaultextension=".csv", initialfile=t("report_file_name"),
            filetypes=[("CSV", "*.csv")])
        if not path:
            return
        # Spanish Excel expects ";" and decimal comma; English, "," and decimal point
        spanish = i18n.get_language() == "es"
        fields = ["source", "target", "status", "message", "rows", "columns", "source_bytes", "parquet_bytes",
                  "parts", "seconds", "format", "separator", "encoding", "decimal", "skipped_rows"]
        with open(path, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f, delimiter=";" if spanish else ",")
            w.writerow(fields)
            for i in sorted(self.results):
                r = self.results[i]
                seconds = f"{r.seconds:.2f}"
                w.writerow([r.source, r.target or "", r.status, r.message, r.rows, r.columns, r.source_bytes,
                            r.parquet_bytes, r.parts, seconds.replace(".", ",") if spanish else seconds,
                            str(r.format) if r.format else "", r.separator, r.encoding, r.decimal, r.skipped_rows])
        self._log(Msg("log_report_saved", path=path), "ok")

    # ------------------------------------------------------------ conversion
    def _busy(self) -> bool:
        return self.thread is not None and self.thread.is_alive()

    def _convert(self):
        if self._busy() or not self.jobs:
            return
        out_dir = self._out_dir()
        if self.v_target_mode.get() == "folder" and out_dir is None:
            messagebox.showwarning(t("app_title"), t("dlg_choose_dest"))
            return
        if self.v_split.get() and self._split_value() is None:
            messagebox.showwarning(t("app_title"), t("dlg_split_value"))
            return
        if out_dir is not None:
            try:
                out_dir.mkdir(parents=True, exist_ok=True)
            except OSError as e:
                messagebox.showerror(t("app_title"), t("dlg_dest_unusable", error=str(e)))
                return
        op = self.options()
        self._save_config()
        self.results.clear()
        for i in range(len(self.jobs)):
            self.table.item(str(i), values=self._row_values(i), tags=self._tags(i, "pending"))
        self.done_bytes = 0
        self.progress["value"] = 0
        self.cancel_event.clear()
        self._lock(True)
        self.tabs.select(0)
        self.started = time.perf_counter()
        if op.combine:
            mode = Msg("mode_combining", name=engine.combined_target(self.jobs, out_dir, op).name)
        else:
            mode = Msg("mode_per_file")
        split = Msg("mode_split", value=self.v_split_value.get(), unit=Msg(SPLIT_LABELS[op.split_mode])) \
            if op.split_mode else ""
        self.combined_info = None
        self._log(Msg("log_start", n=len(self.jobs), compression=op.compression, mode=mode, split=split), "info")
        self.last_target = (engine.combined_target(self.jobs, out_dir, op).parent if op.combine
                            else out_dir or (self.sources[0] if self.sources[0].is_dir() else self.jobs[0][0].parent))
        jobs = list(self.jobs)

        def notify(event, *data):
            self.queue.put((event, *data))

        def task():
            try:
                res = engine.convert_batch(jobs, out_dir, op, notify, self.cancel_event)
                self.queue.put(("finished", res))
            except Exception as e:  # noqa: BLE001
                self.queue.put(("log", Msg("log_unexpected", error=str(e)), "error"))
                self.queue.put(("finished", []))

        self.thread = threading.Thread(target=task, daemon=True)
        self.thread.start()

    def _lock(self, busy: bool):
        for w in self._controls:
            try:
                w.configure(state="disabled" if busy else ("readonly" if isinstance(w, ttk.Combobox) else "normal"))
            except tk.TclError:
                pass
        self.b_convert.configure(state="disabled" if busy else "normal")
        self.b_cancel.configure(state="normal" if busy else "disabled")
        if busy:
            self.b_open.configure(state="disabled")
        else:
            self._update_dependent()

    def _cancel(self):
        if self._busy():
            self.cancel_event.set()
            self._set_status("bar_cancelling")
            self.b_cancel.configure(state="disabled")

    def _poll_queue(self):
        try:
            while True:
                self._handle(self.queue.get_nowait())
        except queue.Empty:
            pass
        self.root.after(80, self._poll_queue)

    def _handle(self, msg):
        event = msg[0]
        total = max(sum(self.sizes), 1)
        if event == "preview":
            _, token, table, fmt, error = msg
            if token == self.preview_token:
                self._show_preview(table, fmt, error)
        elif event == "start":
            i = msg[1]
            self.table.item(str(i), values=self._row_values(i, "converting"), tags=self._tags(i, "converting"))
            self.table.see(str(i))
            self._set_status("bar_converting", i=i + 1, n=len(self.jobs), name=self._rel_name(i))
        elif event == "progress":
            _, i, frac = msg
            self.progress["value"] = 1000 * (self.done_bytes + frac * self.sizes[i]) / total
            self.table.item(str(i), values=self._row_values(i, "converting", extra=f" {frac * 100:.0f} %"))
        elif event == "done":
            _, i, r = msg
            self.results[i] = r
            if r.status != "cancelled":
                self.done_bytes += self.sizes[i]
            self.progress["value"] = 1000 * self.done_bytes / total
            self.table.item(str(i), values=self._row_values(i, r.status, r), tags=self._tags(i, r.status))
            name = self._rel_name(i)
            if r.status == "ok":
                if self.v_output_mode.get() == "combine":
                    dest = ""
                elif r.parts:
                    dest = Msg("log_dest_parts", name=engine.parts_folder(r.target).name, n=r.parts)
                else:
                    dest = Msg("log_dest", name=r.target.name)
                self._log(Msg("log_ok", name=name, dest=dest, n=r.rows, seconds=r.seconds), "ok")
                for m in r.messages:
                    self._log(Msg("log_note", message=m), "warning")
            elif r.status == "skipped":
                self._log(Msg("log_skipped", name=name, message=r.messages[0] if r.messages else ""), "warning")
            elif r.status == "error":
                self._log(Msg("log_error", name=name, message=r.messages[0] if r.messages else ""), "error")
            if self.table.selection() == (str(i),):
                self._on_select()
        elif event == "combining":
            self._set_status("bar_combining")
        elif event == "combined":
            self.combined_info = (msg[1], msg[2])
        elif event == "log":
            self._log(msg[1], msg[2] if len(msg) > 2 else "info")
        elif event == "finished":
            self._finish(msg[1])

    def _finish(self, results: list[engine.Result]):
        self.thread = None
        self._lock(False)
        duration = time.perf_counter() - self.started
        ok = [r for r in results if r.status == "ok"]
        errors = [r for r in results if r.status == "error"]
        skipped = [r for r in results if r.status == "skipped"]
        cancelled = self.cancel_event.is_set()
        if cancelled:
            self.progress["value"] = 0
            for i in range(len(self.jobs)):
                if i not in self.results:
                    self.table.item(str(i), values=self._row_values(i, "cancelled"), tags=self._tags(i, "cancelled"))
        else:
            self.progress["value"] = 1000
        src_bytes = sum(r.source_bytes for r in ok)
        if self.v_output_mode.get() == "combine":
            pq_bytes = self.combined_info[0] if self.combined_info and ok else 0
        else:
            pq_bytes = sum(r.parquet_bytes for r in ok)
        summary = Msg("summary", ok=Msg("sum_ok", n=len(ok)),
                      errors=Msg("sum_errors", n=len(errors)) if errors else "",
                      skipped=Msg("sum_skipped", n=len(skipped)) if skipped else "")
        sizes = None
        if ok and pq_bytes:
            change = (1 - pq_bytes / max(src_bytes, 1)) * 100
            sizes = Msg("sizes_smaller" if change >= 0 else "sizes_larger", src_size=src_bytes, pq_size=pq_bytes,
                        pct=round(abs(change)))
        key = "run_cancelled" if cancelled else "run_finished"
        suffix = Msg("sizes_suffix", sizes=sizes) if sizes else ""
        self._set_status(key, summary=summary, seconds=duration, sizes=suffix)
        self._log(Msg(key, summary=summary, seconds=duration, sizes=suffix), "error" if errors else "ok")
        if ok:
            self.b_open.configure(state="normal")
        if cancelled:
            return
        text = t("dlg_done", summary=str(summary))
        if sizes:
            text += f"\n\n{sizes}."
        if errors:
            text += "\n\n" + t("dlg_errors_hint")
        if ok and messagebox.askyesno(t("app_title"), text + "\n\n" + t("dlg_open_dest"),
                                      icon="warning" if errors else "info"):
            self._open_target()
        elif not ok:
            messagebox.showwarning(t("app_title"), text)

    def _open_target(self):
        if self.last_target is not None:
            open_in_file_manager(self.last_target)

    # ------------------------------------------------------------ config
    def _save_config(self):
        self.config["options"] = {
            "recursive": self.v_recursive.get(), "target_mode": self.v_target_mode.get(),
            "out_dir": self.v_out_dir.get(), "keep_structure": self.v_keep_structure.get(),
            "overwrite": self.v_overwrite.get(), "sep": self.v_sep.get(), "enc": self.v_enc.get(),
            "dec": self.v_dec.get(), "header": self.v_header.get(), "dmy": self.v_dmy.get(),
            "all_text": self.v_all_text.get(), "skip_bad": self.v_skip_bad.get(), "comp": self.v_comp.get(),
            "output_mode": self.v_output_mode.get(), "combined_name": self.v_combined_name.get(),
            "source_col": self.v_source_col.get(), "split": self.v_split.get(),
            "split_mode": self.v_split_mode.get(), "split_value": self.v_split_value.get(),
        }
        save_config(self.config)

    def _on_close(self):
        if self._busy():
            if not messagebox.askyesno(t("app_title"), t("dlg_busy_quit")):
                return
            self.cancel_event.set()
            self.thread.join(timeout=5)
        self._save_config()
        self.root.destroy()


def main(initial_paths: list[str] | None = None):
    if sys.platform.startswith("win"):
        try:  # sharp text on high-resolution screens
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:  # noqa: BLE001
            pass
    config = _config
    root = None
    if dnd_available(config):
        try:
            root = TkinterDnD.Tk()
        except Exception:  # noqa: BLE001
            root = None
    if root is None:
        root = tk.Tk()
    compute_scale(root)
    width, height = px(1260), px(940)
    sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
    width, height = min(width, sw - 40), min(height, sh - 90)
    root.geometry(f"{width}x{height}+{max((sw - width) // 2, 0)}+{max((sh - height) // 3, 0)}")
    root.minsize(min(px(1100), sw - 40), min(px(600), sh - 90))
    app = App(root, config)
    if initial_paths:
        root.after(200, lambda: app.set_sources([Path(x) for x in initial_paths]))
    root.mainloop()


if __name__ == "__main__":
    main(sys.argv[1:])

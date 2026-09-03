"""``python -m signal_plus`` entry point.

CR-M-3 (PR #650 code review, id 5105099737): the real deployed entry point
is the ``signal-plus`` console script (``pyproject.toml``'s
``[project.scripts]``, used by the Dockerfile's ``CMD``), which already
works without this file. This exists only so ``python -m signal_plus`` --
the conventional way to run a package that has no installed script on
``PATH`` yet (e.g. straight from a checkout with ``pip install -e .`` not
yet run, or inside a bare venv) -- also works, matching
``signal_plus/cli.py``'s own ``if __name__ == "__main__":`` guard.
"""
from __future__ import annotations

from signal_plus.cli import main

if __name__ == "__main__":
    raise SystemExit(main())

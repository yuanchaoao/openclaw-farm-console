#!/usr/bin/env python3
"""Compatibility entry point; use scripts/install/install.sh without Python."""
from pathlib import Path
import runpy
import sys
sys.argv.insert(1,'install')
runpy.run_path(str(Path(__file__).resolve().parents[2] / 'control.py'),run_name='__main__')

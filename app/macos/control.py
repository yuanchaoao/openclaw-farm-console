#!/usr/bin/env python3
"""Compatibility entry point for the cross-platform controller."""
from pathlib import Path
import runpy
runpy.run_path(str(Path(__file__).resolve().parents[2] / 'control.py'),run_name='__main__')

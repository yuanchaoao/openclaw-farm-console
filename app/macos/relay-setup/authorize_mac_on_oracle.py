#!/usr/bin/env python3
"""Compatibility entry point for generic relay key registration."""
from pathlib import Path
import runpy
runpy.run_path(str(Path(__file__).resolve().parents[3] / 'relay' / 'authorize_key.py'), run_name='__main__')

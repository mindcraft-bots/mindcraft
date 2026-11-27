#!/usr/bin/env python3
"""Time the mandatory live schematic suite and retain its output privately."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runner', required=True, choices=('make', 'task'))
    parser.add_argument('--log', required=True, type=Path, help='new log file; parent must already exist')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    command = ['make', 'test-schematics'] if args.runner == 'make' else ['task', 'test:schematics']
    try:
        fd = os.open(args.log, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    except OSError as error:
        print(f'Cannot create new log: {error}', file=sys.stderr)
        return 2
    start = time.monotonic()
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as log:
            result = subprocess.run(command, cwd=root, stdout=log, stderr=subprocess.STDOUT, check=False)
        status = result.returncode if result.returncode >= 0 else 128 - result.returncode
    except OSError as error:
        print(f'Unable to start runner: {error}', file=sys.stderr)
        status = 127
    print(f'Wall: {time.monotonic() - start:.3f} s; exit: {status}; log: {args.log.absolute()}')
    return status


if __name__ == '__main__':
    sys.exit(main())

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('batch', ROOT / 'tasks/run_task_file.py')
batch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(batch)


class BatchTests(unittest.TestCase):
    def run_fake(self, result, code=0, timeout=False):
        class Process:
            pid = 12345
            def __init__(self, cmd, **kwargs):
                if result is not None:
                    Path(kwargs['env']['TASK_RESULT_FILE']).write_text(json.dumps(result))
            def wait(self, timeout=None):
                if timeout is not None and timeout_flag:
                    raise subprocess.TimeoutExpired('node', timeout)
                return code
        timeout_flag = timeout
        with patch.object(batch.subprocess, 'Popen', Process), patch.object(batch.os, 'killpg'):
            return batch.run_task('tasks/schematics_test.json', 'one', {'type': 'schematic', 'timeout': 1})

    def test_success_requires_matching_result(self):
        self.assertTrue(self.run_fake({'task_id': 'one', 'message': 'Task successful', 'score': 1}))
        for result in (None, {'task_id': 'wrong', 'message': 'Task successful', 'score': 1},
                       {'task_id': 'one', 'message': 'Task timeout reached', 'score': 0.5}):
            self.assertFalse(self.run_fake(result))
        self.assertFalse(self.run_fake({'task_id': 'one', 'message': 'Task successful', 'score': 1}, code=2))
        self.assertFalse(self.run_fake(None, timeout=True))


if __name__ == '__main__':
    unittest.main()

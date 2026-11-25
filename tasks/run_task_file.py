# Run each task in a fresh Mindcraft process and report the aggregate result.
import argparse
import json
import os
import signal
import subprocess
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_task(task_path, task_id, task, profiles=None, timeout=None):
    cmd = ['node', 'main.js', '--task_path', os.path.abspath(task_path), '--task_id', task_id]
    if profiles:
        cmd.extend(['--profiles', *profiles])
    print(f'Running task: {task_id}', flush=True)
    with tempfile.TemporaryDirectory(prefix='mindcraft-task-') as directory:
        result_path = os.path.join(directory, 'result.json')
        env = dict(os.environ, TASK_RESULT_FILE=result_path)
        process = subprocess.Popen(cmd, cwd=ROOT, env=env, start_new_session=True)
        try:
            code = process.wait(timeout=timeout or max(120, int(task.get('timeout', 300)) + 90))
        except subprocess.TimeoutExpired:
            print(f'{task_id}: process timed out', flush=True)
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            return False
        finally:
            # A crashed parent can leave agent children behind.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if code != 0:
            print(f'{task_id}: process exited {code}', flush=True)
            return False
        if task.get('type') != 'schematic':
            return True  # Existing task types do not yet emit a structured result.
        try:
            with open(result_path, encoding='utf-8') as f:
                result = json.load(f)
            print(f'{task_id}: {result}', flush=True)
            return result.get('task_id') == task_id and result.get('message') == 'Task successful' and result.get('score') == 1
        except (OSError, ValueError) as exc:
            print(f'{task_id}: missing or invalid result: {exc}', flush=True)
            return False


def main():
    parser = argparse.ArgumentParser(description='Run tasks sequentially')
    parser.add_argument('--task_path', required=True)
    parser.add_argument('--profiles', nargs='+')
    parser.add_argument('--delay', type=float, default=2)
    parser.add_argument('--timeout', type=int, help='Maximum seconds per process')
    args = parser.parse_args()
    with open(args.task_path, encoding='utf-8') as f:
        tasks = json.load(f)
    if not isinstance(tasks, dict) or not tasks:
        raise ValueError('Task suite must be a nonempty object')
    successes = 0
    for index, (task_id, task) in enumerate(tasks.items()):
        successes += run_task(args.task_path, task_id, task, args.profiles, args.timeout)
        if index + 1 < len(tasks):
            time.sleep(args.delay)
    print(f'Completed {successes}/{len(tasks)} tasks successfully', flush=True)
    return 0 if successes == len(tasks) else 1


if __name__ == '__main__':
    raise SystemExit(main())

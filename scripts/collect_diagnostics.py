#!/usr/bin/env python3
# Standalone collector for copying to a Docker host.
import errno
import json
import os
import posixpath
import re
import shutil
import stat
import subprocess
import sys
import tempfile

# Keep all collected diagnostics private, regardless of the caller's umask.
os.umask(0o077)


def usage(stream=sys.stdout):
    print('Usage: collect_diagnostics.py [--project-directory DIR] [--output-directory DIR]\n'
          'Collect Compose logs, selected metadata and sensitive bot history/prompt logs.\n'
          'Default project: the parent of the resolved script directory.\n'
          'Default output directory: tmp within the selected project directory.\n'
          'Relative DIR overrides are resolved against the invocation working directory.\n'
          'Output: a new private mindcraft-bot-diagnostics.* bundle within the output directory.\n'
          'Review and redact all contents before private transfer.', file=stream)

args = sys.argv[1:]
if args in (['-h'], ['--help']):
    usage()
    sys.exit(0)
options = {}
while args:
    if (len(args) < 2 or args[0] not in ('--project-directory', '--output-directory')
            or args[0] in options or not args[1] or args[1].startswith('--')):
        usage(sys.stderr)
        sys.exit(2)
    options[args[0]] = os.path.abspath(args[1])
    args = args[2:]
project = options.get('--project-directory', os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
output_directory = options.get('--output-directory')
try:
    os.chdir(project)
    project = os.getcwd()
except OSError:
    print('Error: cannot enter the Compose project directory.', file=sys.stderr)
    sys.exit(2)
if not shutil.which('docker'):
    print('Error: Docker CLI not found on this host.', file=sys.stderr)
    sys.exit(2)
if output_directory is None:
    output_directory = os.path.join(project, 'tmp')
try:
    os.makedirs(output_directory, mode=0o700, exist_ok=True)
    if not stat.S_ISDIR(os.lstat(output_directory).st_mode):
        raise OSError('output directory must be a directory, not a symlink')
    output_directory = os.path.realpath(output_directory)
    output = tempfile.mkdtemp(prefix='mindcraft-bot-diagnostics.', dir=output_directory)
except OSError as exc:
    print('Error: cannot create a private output directory: ' + str(exc), file=sys.stderr)
    sys.exit(2)
print('Output directory: ' + output, flush=True)
print('Warning: chats, prompts, logs and mount paths are highly sensitive; review and redact before private sharing.', file=sys.stderr)
status = open(os.path.join(output, 'collection-status.txt'), 'w', encoding='utf-8')
status.write('Mindcraft bot diagnostics: see stderr for Docker/Compose errors.\n')
failed = False


def report(message, error=False):
    global failed
    if error:
        failed = True
    status.write(message + '\n')
    status.flush()
    print(message, file=sys.stderr)


def run(command):
    # Docker stderr is deliberately not persisted: it can contain credentials.
    try:
        return subprocess.run(command, stdout=subprocess.PIPE, check=False)
    except OSError as exc:
        print('Docker command failed: ' + str(exc), file=sys.stderr)
        return None


def text(data):
    return data.decode('utf-8', 'replace')


def write(name, data):
    with open(os.path.join(output, name), 'wb') as f:
        f.write(data)


def collect_logs(service):
    filename = os.path.join(output, service + '-logs.txt')
    try:
        # Stream potentially very large retained logs directly to disk.
        with open(filename, 'wb') as f:
            result = subprocess.run(compose + ['logs', '--no-color', '--timestamps', '--tail=all', service], stdout=f, check=False)
        if result.returncode:
            report('ERROR: Compose logs failed for ' + service + '; its log file may be partial.', True)
        elif os.path.getsize(filename) == 0:
            report('MISSING OPTIONAL: no retained Compose log output for ' + service + '.')
        else:
            report('Collected available Compose logs for ' + service + '.')
    except OSError as exc:
        problem('cannot collect Compose logs for ' + service, exc)

compose = ['docker', 'compose', '--project-directory', project]
result = run(compose + ['config', '--services'])
if result is None or result.returncode:
    report('ERROR: could not list Compose services; check Docker Compose and project configuration.', True)
    sys.exit(1)
services = text(result.stdout).splitlines()
if not services:
    report('ERROR: selected Compose configuration has no services.', True)

# Only selected inspect fields are emitted. Mount records are removed before
# writing metadata and parsed separately; neither environment nor full inspect
# output is saved.
inspect_format = ('{{printf "container_id=%s\\ncontainer_name=%s\\nimage_id=%s\\nconfigured_image=%s\\nstate=%s\\n" .Id .Name .Image .Config.Image .State.Status}}'
                  '{{range (index . "Mounts")}}{{printf "mount type=%q name=%q source=%q destination=%q rw=" (or (index . "Type") "") (or (index . "Name") "") (or (index . "Source") "") (or (index . "Destination") "")}}'
                  '{{if eq (index . "RW") nil}}unknown{{else}}{{index . "RW"}}{{end}}{{printf "\\n"}}'
                  '{{printf "MINDCRAFT_MOUNT\\t%s\\t%s\\t%s\\n" (json (or (index . "Type") "")) (json (or (index . "Source") "")) (json (or (index . "Destination") ""))}}{{end}}')

# Never interpret daemon-host paths as local paths for a remote context.
local_daemon = None

def is_local_daemon():
    global local_daemon
    if local_daemon is None:
        host = os.environ.get('DOCKER_HOST', '') if not os.environ.get('DOCKER_CONTEXT') else ''
        if not host:
            result = run(['docker', 'context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'])
            try:
                host = json.loads(text(result.stdout)) if result and not result.returncode else ''
            except (ValueError, TypeError):
                host = ''
        local_daemon = isinstance(host, str) and host.startswith('unix://')
    return local_daemon

sources = {}
source_count = 0
flags_dir = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
flags_file = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK


def display(value):
    return json.dumps(value, ensure_ascii=True)


def problem(context, exc):
    reason = exc.strerror if isinstance(exc, OSError) and exc.strerror else str(exc)
    report('ERROR: ' + context + ': ' + reason, True)


def open_dir(parent, name):
    return os.open(name, flags_dir, dir_fd=parent)


def copy_file(parent, name, dest, label):
    try:
        fd = os.open(name, flags_file, dir_fd=parent)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                report('ERROR: skipped non-regular diagnostic file ' + display(label), True)
                return
            os.makedirs(os.path.dirname(dest), mode=0o700, exist_ok=True)
            with os.fdopen(fd, 'rb', closefd=False) as src, open(dest, 'xb') as dst:
                shutil.copyfileobj(src, dst)
            report('COLLECTED: ' + display(label) + ' -> ' + display(os.path.relpath(dest, output)))
        finally:
            os.close(fd)
    except OSError as exc:
        problem('cannot copy ' + display(label), exc)


def logs_tree(fd, dest, label):
    try:
        names = sorted(os.listdir(fd))
    except OSError as exc:
        problem('cannot list ' + display(label), exc)
        return
    if not names:
        report('MISSING OPTIONAL: empty log directory ' + display(label))
    for name in names:
        child = label + '/' + name
        try:
            mode = os.stat(name, dir_fd=fd, follow_symlinks=False).st_mode
            if stat.S_ISDIR(mode):
                sub = open_dir(fd, name)
                try:
                    logs_tree(sub, os.path.join(dest, name), child)
                finally:
                    os.close(sub)
            elif stat.S_ISREG(mode):
                copy_file(fd, name, os.path.join(dest, name), child)
            else:
                report('ERROR: skipped symlink or special log entry ' + display(child), True)
        except OSError as exc:
            problem('cannot inspect ' + display(child), exc)


def collect_agent(rootfd, agent, base, label):
    try:
        fd = open_dir(rootfd, agent)
    except OSError as exc:
        problem('cannot open agent directory ' + display(label), exc)
        return
    try:
        try:
            os.stat('memory.json', dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            report('MISSING OPTIONAL: ' + display(label + '/memory.json'))
        except OSError as exc:
            problem('cannot inspect ' + display(label + '/memory.json'), exc)
        else:
            copy_file(fd, 'memory.json', os.path.join(base, agent, 'memory.json'), label + '/memory.json')
        for dirname in ('histories', 'logs'):
            sublabel = label + '/' + dirname
            try:
                sub = open_dir(fd, dirname)
            except FileNotFoundError:
                report('MISSING OPTIONAL: ' + display(sublabel))
                continue
            except OSError as exc:
                problem('cannot open ' + display(sublabel), exc)
                continue
            try:
                dest = os.path.join(base, agent, dirname)
                if dirname == 'logs':
                    logs_tree(sub, dest, sublabel)
                else:
                    try:
                        names = sorted(n for n in os.listdir(sub) if n.endswith('.json'))
                    except OSError as exc:
                        problem('cannot list ' + display(sublabel), exc)
                        continue
                    if not names:
                        report('MISSING OPTIONAL: no history JSON files in ' + display(sublabel))
                    for name in names:
                        copy_file(sub, name, os.path.join(dest, name), sublabel + '/' + name)
            finally:
                os.close(sub)
    finally:
        os.close(fd)


def collect_source(source, suffix, service, container):
    global source_count
    context = service + ' container ' + container
    if not is_local_daemon():
        report('ERROR: cannot collect /app/bots for ' + context + ': Docker daemon is remote or its context could not be verified; daemon mount source ' + display(source), True)
        return
    if not source or not os.path.isabs(source):
        report('ERROR: invalid daemon mount source for ' + context + ': ' + display(source), True)
        return
    root = os.path.normpath(os.path.join(source, *suffix))
    # Do not recursively copy the output into itself if it sits in the source.
    if os.path.commonpath((os.path.realpath(root), output)) == os.path.realpath(root):
        report('ERROR: output directory is inside bot source ' + display(root), True)
        return
    try:
        # The mount source itself is trusted as the daemon-reported root, but
        # do not follow symlinks in its descendants or any selected files.
        fd = os.open(source, flags_dir)
        try:
            for component in suffix:
                nextfd = open_dir(fd, component)
                os.close(fd)
                fd = nextfd
            key = (os.fstat(fd).st_dev, os.fstat(fd).st_ino)
            if key in sources:
                report('SHARED: ' + context + ' /app/bots -> ' + sources[key] + ' (source ' + display(root) + ')')
                return
            source_count += 1
            relative = 'bot-data/source-%03d' % source_count
            sources[key] = relative
            report('SOURCE: ' + context + ' /app/bots ' + display(root) + ' -> ' + relative)
            names = sorted(os.listdir(fd))
            if not names:
                report('MISSING OPTIONAL: no agents in ' + display(root))
            for name in names:
                try:
                    mode = os.stat(name, dir_fd=fd, follow_symlinks=False).st_mode
                    if stat.S_ISDIR(mode):
                        collect_agent(fd, name, os.path.join(output, relative), root + '/' + name)
                    elif stat.S_ISLNK(mode):
                        report('ERROR: skipped symlink agent entry ' + display(root + '/' + name), True)
                except OSError as exc:
                    problem('cannot inspect agent entry ' + display(root + '/' + name), exc)
        finally:
            os.close(fd)
    except OSError as exc:
        problem('cannot access /app/bots source ' + display(root) + ' for ' + context, exc)


for service in services:
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', service):
        report('ERROR: unsafe Compose service name ' + display(service), True)
        continue
    bot = service.startswith('bot-')
    ids = run(compose + ['ps', '--all', '--quiet', service])
    write(service + '-container-ids.txt', ids.stdout if ids else b'')
    metadata = bytearray()
    if ids is None or ids.returncode:
        report('ERROR: could not list retained containers for ' + service + '.', True)
    elif not ids.stdout.strip():
        report(('ERROR: ' if bot else 'MISSING OPTIONAL: ') + 'no retained Compose containers found for ' + service + '.', bot)
    else:
        for container in text(ids.stdout).splitlines():
            if not re.fullmatch(r'[A-Za-z0-9_.-]+', container):
                report('ERROR: unsafe container ID for ' + service + ': ' + display(container), True)
                continue
            inspected = run(['docker', 'inspect', '--format', inspect_format, container])
            if inspected is None or inspected.returncode:
                report('ERROR: selected metadata inspection failed for ' + service + ' container ' + container + '.', True)
                continue
            mounts = []
            malformed = False
            for line in inspected.stdout.splitlines(keepends=True):
                if line.startswith(b'MINDCRAFT_MOUNT\t'):
                    try:
                        parts = line.rstrip(b'\r\n').split(b'\t')[1:]
                        mount = [json.loads(text(part)) for part in parts]
                        if len(mount) != 3 or not all(isinstance(x, str) for x in mount):
                            raise ValueError('invalid mount record')
                        mounts.append(mount)
                    except ValueError:
                        malformed = True
                else:
                    metadata.extend(line)
            if malformed:
                report('ERROR: invalid mount inspection data for ' + service + ' container ' + container + '.', True)
                continue
            candidates = [(typ, src, dst) for typ, src, dst in mounts if dst.startswith('/') and (dst == '/app/bots' or '/app/bots'.startswith(dst.rstrip('/') + '/'))]
            nested = [dst for _, _, dst in mounts if dst.startswith('/app/bots/')]
            if nested:
                report('ERROR: nested mounts under /app/bots for ' + service + ' container ' + container + ' are unsupported: ' + display(nested), True)
                continue
            if not candidates:
                report(('ERROR: ' if bot else 'NOT APPLICABLE: ') + 'no /app/bots mount for ' + service + ' container ' + container + '; container-only bot data is not collected.', bot)
                continue
            typ, src, dst = max(candidates, key=lambda m: len(m[2]))
            if typ not in ('bind', 'volume'):
                report('ERROR: unsupported /app/bots mount type ' + display(typ) + ' for ' + service + ' container ' + container, True)
                continue
            suffix = posixpath.relpath('/app/bots', dst).split('/')
            collect_source(src, [] if suffix == ['.'] else suffix, service, container)
    write(service + '-metadata.txt', metadata)
    collect_logs(service)

if failed:
    report('Collection incomplete; retained output may be partial. See errors above.')
else:
    report('Collection finished. Log rotation, deletion, or the logging driver may limit available history.')
status.close()
sys.exit(1 if failed else 0)

#!/usr/bin/env bash
# SPDX-License-Identifier: EUPL-1.2
# Notebook-only Darwin variant of governance ed87f3f install-toolchains.sh.
# Archive extraction, limits and activation checks retain that installer recipe.
set -euo pipefail
if [[ $# -ne 2 ]]; then
  echo 'Usage: install-toolchains.sh ABSOLUTE_BUN_POLICY ABSOLUTE_NOTEBOOK_POLICY' >&2
  exit 2
fi
python3 - "$@" <<'PYTHON'
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
import zipfile

LIMIT = 256 * 1024 * 1024

def verify_digest(path, expected):
    if not isinstance(expected, str) or not re.fullmatch(r'[a-f0-9]{64}', expected):
        raise ValueError('Invalid expected digest')
    if path.stat().st_size > LIMIT:
        raise ValueError('Toolchain file exceeds byte limit')
    with path.open('rb') as stream:
        hasher = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(chunk)
        actual = hasher.hexdigest()
    if actual != expected:
        raise ValueError('Toolchain digest mismatch')

def validate_policies(bun, notebook):
    try:
        node = notebook['node']
        b = bun['assets']['darwin-arm64']
        n = node['platforms']['darwin-arm64']
        release = bun['durableRelease']['url']
        if release != 'https://github.com/libre-ai/project-governance/releases/tag/toolchain-bun-1.4.0-canary.1-57f349f63' or b['name'] != 'bun-darwin-aarch64.zip':
            raise ValueError('Unexpected Bun release')
        bu = release.replace('/tag/', '/download/') + '/' + b['name']
        if bun['revision'] != '1.4.0-canary.1+57f349f63' or node['version'] != '26.5.0':
            raise ValueError('Unexpected toolchain version')
        if bu != 'https://github.com/libre-ai/project-governance/releases/download/toolchain-bun-1.4.0-canary.1-57f349f63/bun-darwin-aarch64.zip':
            raise ValueError('Unexpected Bun archive URL')
        if n['archiveUrl'] != 'https://nodejs.org/dist/v26.5.0/node-v26.5.0-darwin-arm64.tar.xz':
            raise ValueError('Unexpected Node archive URL')
        for digest in [b['sha256'], n['archiveSha256'], n['executableSha256']]:
            if not isinstance(digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest):
                raise ValueError('Invalid policy digest')
        if n['executableRelativePath'] != 'bin/node':
            raise ValueError('Unexpected Node executable path')
        return bu, b['sha256'], n
    except (KeyError, TypeError) as error:
        raise ValueError('Incomplete toolchain policy') from error

def safe_member(name):
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or '\\' in name:
        raise ValueError('Unsafe archive member')

def extract_binary(archive, member, destination, zipped):
    # Extract only the selected regular binary; no archive links are followed.
    if zipped:
        with zipfile.ZipFile(archive) as container:
            entries = container.infolist()
            if len(entries) > 100000:
                raise ValueError('Archive inventory too large')
            for entry in entries:
                safe_member(entry.filename)
            matches = [entry for entry in entries if entry.filename == member]
            if len(matches) != 1 or matches[0].is_dir() or stat.S_ISLNK(matches[0].external_attr >> 16):
                raise ValueError('Missing or nonregular toolchain binary')
            if matches[0].file_size > LIMIT:
                raise ValueError('Toolchain binary exceeds byte limit')
            content = container.read(matches[0])
    else:
        content = None
        with tarfile.open(archive, 'r:xz') as container:
            for count, entry in enumerate(container):
                if count >= 100000:
                    raise ValueError('Archive inventory too large')
                safe_member(entry.name)
                if entry.name == member:
                    if content is not None or not entry.isfile() or entry.size > LIMIT:
                        raise ValueError('Invalid toolchain binary member')
                    with container.extractfile(entry) as stream:
                        content = stream.read(LIMIT + 1)
        if content is None:
            raise ValueError('Missing toolchain binary')
    destination.write_bytes(content)
    destination.chmod(0o755)

def policy(path):
    p = Path(path)
    if not p.is_absolute() or p.resolve() != p or not p.is_file() or p.stat().st_size > 65536:
        raise ValueError('Policy must be a bounded canonical regular file')
    return json.loads(p.read_text())

def main():
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise ValueError('This installer supports macOS ARM64 only')
    bu, bh, node = validate_policies(policy(sys.argv[1]), policy(sys.argv[2]))
    parent = Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
    outputs = [Path(os.environ[key]) for key in ['GITHUB_PATH', 'GITHUB_ENV']]
    if '\n' in str(parent) or '\r' in str(parent) or not parent.is_dir() or any(not p.is_absolute() or p.is_symlink() or not p.is_file() for p in outputs):
        raise ValueError('Invalid runner output paths')
    root = Path(tempfile.mkdtemp(prefix='libre-ai-toolchains-', dir=parent))
    for url, digest, filename, member, zipped, binary in [
        (bu, bh, 'bun.zip', 'bun-darwin-aarch64/bun', True, 'bun'),
        (node['archiveUrl'], node['archiveSha256'], 'node.tar.xz', 'node-v26.5.0-darwin-arm64/bin/node', False, 'node'),
    ]:
        archive = root / filename
        subprocess.run(['curl', '--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '15', '--max-time', '120', '--max-filesize', str(LIMIT), '--output', str(archive), url], check=True, timeout=125)
        verify_digest(archive, digest)
        extract_binary(archive, member, root / binary, zipped)
    verify_digest(root / 'node', node['executableSha256'])
    for binary, flag, expected in [('bun', '--revision', '1.4.0-canary.1+57f349f63'), ('node', '--version', 'v26.5.0')]:
        version = subprocess.check_output([str(root / binary), flag], timeout=10, env={'PATH': '/usr/bin:/bin'}).decode().strip()
        if version != expected:
            raise ValueError('Extracted toolchain version mismatch')
    # Activate only after both archives, the Node binary and both versions pass.
    with outputs[0].open('a') as stream:
        stream.write(str(root) + '\n')
    with outputs[1].open('a') as stream:
        stream.write('NOTEBOOK_QUALIFICATION_NODE=' + str(root / 'node') + '\n')
    print('Bun and Node verified for macOS ARM64; subsequent steps receive the exact paths.')

if __name__ == '__main__':
    main()
PYTHON

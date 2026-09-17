# SPDX-License-Identifier: EUPL-1.2
import hashlib, io, pathlib, tarfile, tempfile, unittest, zipfile, json, os, shutil
from unittest.mock import patch
SCRIPT = pathlib.Path(__file__).with_name('install-macos-toolchains.sh')

class InstallerTests(unittest.TestCase):

    def setUp(self):
        code = SCRIPT.read_text().split("<<'PYTHON'\n", 1)[1].rsplit('\nPYTHON', 1)[0]
        self.ns = {'__name__': 'fixture'}
        exec(compile(code, str(SCRIPT), 'exec'), self.ns)

    def test_digest_refusal(self):
        with tempfile.TemporaryDirectory() as d:
            p = pathlib.Path(d) / 'x'
            p.write_bytes(b'fixture')
            with self.assertRaises(ValueError):
                self.ns['verify_digest'](p, '0' * 64)
            self.ns['verify_digest'](p, hashlib.sha256(b'fixture').hexdigest())

    def test_archives_require_exact_regular_binary(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            a = root / 'node.tar.xz'
            with tarfile.open(a, 'w:xz') as t:
                f = tarfile.TarInfo('node-v26.5.0-darwin-arm64/bin/node')
                f.size = 2
                t.addfile(f, io.BytesIO(b'ok'))
            self.ns['extract_binary'](a, 'node-v26.5.0-darwin-arm64/bin/node', root / 'node', False)
            self.assertEqual((root / 'node').read_bytes(), b'ok')
            with zipfile.ZipFile(root / 'bad.zip', 'w') as z:
                z.writestr('../escape', b'x')
                z.writestr('bun-darwin-aarch64/bun', b'ok')
            with self.assertRaises(ValueError):
                self.ns['extract_binary'](root / 'bad.zip', 'bun-darwin-aarch64/bun', root / 'bun', True)

    def test_only_rehosted_bun_url_is_accepted(self):
        bun = {
            'revision': '1.4.0-canary.1+57f349f63',
            'assets': {'darwin-arm64': {'name': 'bun-darwin-aarch64.zip', 'sha256': 'a' * 64}},
            'durableRelease': {},
        }
        node = {'node': {'version': '26.5.0', 'platforms': {'darwin-arm64': {
            'archiveUrl': 'https://nodejs.org/dist/v26.5.0/node-v26.5.0-darwin-arm64.tar.xz',
            'archiveSha256': 'b' * 64, 'executableSha256': 'c' * 64,
            'executableRelativePath': 'bin/node',
        }}}}
        target = 'https://github.com/libre-ai/project-governance/releases/download/toolchain-bun-1.4.0-canary.1-57f349f63/bun-darwin-aarch64.zip'
        bun['durableRelease']['url'] = target.rsplit('/download/', 1)[0] + '/tag/toolchain-bun-1.4.0-canary.1-57f349f63'
        self.assertEqual(self.ns['validate_policies'](bun, node)[0], target)
        for bad in [target.replace('/project-governance/', '/governance/'), target.replace('github.com/', 'github.com.invalid/')]:
            bun['durableRelease']['url'] = bad.rsplit('/download/', 1)[0] + '/tag/toolchain-bun-1.4.0-canary.1-57f349f63'
            with self.assertRaises(ValueError):
                self.ns['validate_policies'](bun, node)

    def test_wrong_policy(self):
        with self.assertRaises(ValueError):
            self.ns['validate_policies']({}, {})

    def test_activation_waits_for_all_digests_and_versions(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d).resolve()
            z = root / 'fixture.zip'
            t = root / 'fixture.tar.xz'
            with zipfile.ZipFile(z, 'w') as out:
                out.writestr('bun-darwin-aarch64/bun', b'bun')
            with tarfile.open(t, 'w:xz') as out:
                entry = tarfile.TarInfo('node-v26.5.0-darwin-arm64/bin/node')
                entry.size = 4
                out.addfile(entry, io.BytesIO(b'node'))
            digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
            bp = root / 'bun.json'
            np = root / 'node.json'
            gp = root / 'path'
            ge = root / 'env'
            gp.write_text('')
            ge.write_text('')
            bun = {'revision': '1.4.0-canary.1+57f349f63', 'assets': {'darwin-arm64': {'name': 'bun-darwin-aarch64.zip', 'sha256': digest(z)}}, 'durableRelease': {'url': 'https://github.com/libre-ai/project-governance/releases/tag/toolchain-bun-1.4.0-canary.1-57f349f63'}}
            node = {'node': {'version': '26.5.0', 'platforms': {'darwin-arm64': {'archiveUrl': 'https://nodejs.org/dist/v26.5.0/node-v26.5.0-darwin-arm64.tar.xz', 'archiveSha256': digest(t), 'executableSha256': '0' * 64, 'executableRelativePath': 'bin/node'}}}}
            bp.write_text(json.dumps(bun))
            np.write_text(json.dumps(node))

            def download(args, **kwargs):
                shutil.copyfile(z if args[-1].endswith('.zip') else t, args[args.index('--output') + 1])
            env = {'RUNNER_TEMP': str(root), 'GITHUB_PATH': str(gp), 'GITHUB_ENV': str(ge)}
            with patch.dict(os.environ, env), patch('sys.argv', ['script', str(bp), str(np)]), patch('platform.system', return_value='Darwin'), patch('platform.machine', return_value='arm64'), patch('subprocess.run', side_effect=download), patch('subprocess.check_output', side_effect=[b'1.4.0-canary.1+57f349f63', b'v26.5.0']):
                with self.assertRaises(ValueError):
                    self.ns['main']()
                self.assertEqual(gp.read_text(), '')
                self.assertEqual(ge.read_text(), '')
                node['node']['platforms']['darwin-arm64']['executableSha256'] = hashlib.sha256(b'node').hexdigest()
                np.write_text(json.dumps(node))
                self.ns['main']()
            self.assertIn('libre-ai-toolchains-', gp.read_text())
            self.assertIn('NOTEBOOK_QUALIFICATION_NODE=', ge.read_text())

    def test_wrong_architecture_precedes_download(self):
        with patch('platform.system', return_value='Linux'), patch('platform.machine', return_value='x86_64'), patch('subprocess.run') as download, patch('sys.argv', ['script', 'absent', 'absent']):
            with self.assertRaisesRegex(ValueError, 'macOS ARM64'):
                self.ns['main']()
            download.assert_not_called()
if __name__ == '__main__':
    unittest.main()

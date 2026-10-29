'use strict';

/**
 * build.js — builds multi-platform binaries and packages them
 * for Anna binary distribution.
 *
 * Run: node build.js
 * Output: dist/ folder with tar.gz and zip archives ready for anna-app publish
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const VERSION = require('./package.json').version;
const DIST_BIN = path.join(__dirname, 'dist-bin');
const DIST = path.join(__dirname, 'dist');

// Clean and create output dirs
if (fs.existsSync(DIST_BIN)) fs.rmSync(DIST_BIN, { recursive: true });
if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true });
fs.mkdirSync(DIST_BIN, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });

console.log('📦 Building binaries with pkg...');
try {
  execSync(
    'npx --yes @yao-pkg/pkg . --targets node18-macos-arm64,node18-macos-x64,node18-linux-x64,node18-win-x64 --out-path dist-bin',
    { stdio: 'inherit', cwd: __dirname }
  );
} catch (e) {
  console.error('❌ pkg build failed:', e.message);
  process.exit(1);
}

// pkg output filenames
const pkgOutputs = {
  'darwin-arm64':  path.join(DIST_BIN, 'loom-agent-macos-arm64'),
  'darwin-x86_64': path.join(DIST_BIN, 'loom-agent-macos'),
  'linux-x86_64':  path.join(DIST_BIN, 'loom-agent-linux'),
  'windows-x86_64': path.join(DIST_BIN, 'loom-agent-win.exe'),
};

// Target archive names and entrypoints
const targets = [
  { platform: 'darwin-arm64',   src: pkgOutputs['darwin-arm64'],   entry: 'loom-agent',     ext: 'tar.gz' },
  { platform: 'darwin-x86_64',  src: pkgOutputs['darwin-x86_64'],  entry: 'loom-agent',     ext: 'tar.gz' },
  { platform: 'linux-x86_64',   src: pkgOutputs['linux-x86_64'],   entry: 'loom-agent',     ext: 'tar.gz' },
  { platform: 'windows-x86_64', src: pkgOutputs['windows-x86_64'], entry: 'loom-agent.exe', ext: 'zip'    },
];

console.log('\n📦 Packaging archives...');

for (const t of targets) {
  if (!fs.existsSync(t.src)) {
    console.error(`❌ Binary not found: ${t.src}`);
    process.exit(1);
  }

  const archiveName = `loom-agent-${VERSION}-${t.platform}.${t.ext}`;
  const archivePath = path.join(DIST, archiveName);

  // Rename binary to correct entrypoint name in a temp dir
  const tmpDir = path.join(DIST_BIN, `tmp-${t.platform}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.copyFileSync(t.src, path.join(tmpDir, t.entry));

  if (t.ext === 'tar.gz') {
    execSync(`tar -czf "${archivePath}" -C "${tmpDir}" "${t.entry}"`, { stdio: 'inherit' });
  } else {
    // PowerShell zip on Windows
    execSync(
      `powershell -Command "Compress-Archive -Force -Path '${path.join(tmpDir, t.entry)}' -DestinationPath '${archivePath}'"`,
      { stdio: 'inherit' }
    );
  }

  fs.rmSync(tmpDir, { recursive: true });
  console.log(`  ✅ ${archiveName}`);
}

console.log('\n✅ All archives ready in dist/');
console.log('   Next: anna-app apps publish --bump patch');

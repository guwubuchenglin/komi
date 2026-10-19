// 把根目录的卸载程序复制进打包目录（便携版 win-unpacked 用户也要能一键卸载）
//   node tools/copy-uninstaller.mjs [目标目录，默认 dist/win-unpacked]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const target = path.resolve(root, process.argv[2] ?? path.join('dist', 'win-unpacked'));
const files = ['Uninstall-Komi.exe', '卸载 Komi.exe'];

// 缺了就现场编译，避免打包产物里没有卸载程序
if (!files.some((n) => fs.existsSync(path.join(root, n)))) {
  console.log('根目录没有卸载程序，正在编译…');
  try {
    execFileSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'tools', 'build-launcher.ps1')],
      { stdio: 'inherit', cwd: root },
    );
  } catch (err) {
    console.warn('编译卸载程序失败：' + err.message);
  }
}

if (!fs.existsSync(target)) {
  console.log(`跳过：目标目录不存在 ${target}`);
  process.exit(0);
}

let copied = 0;
for (const name of files) {
  const src = path.join(root, name);
  if (!fs.existsSync(src)) continue;
  fs.copyFileSync(src, path.join(target, name));
  copied += 1;
}
console.log(copied ? `已放入卸载程序 ${copied} 个 → ${target}` : '没有找到卸载程序（先跑 npm run exe）');

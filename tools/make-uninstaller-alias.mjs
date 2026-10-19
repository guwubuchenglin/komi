// 给卸载程序创建一份中文名副本（PowerShell 5.1 读 UTF-8 脚本会把中文文件名弄乱，所以放这里）
//   node tools/make-uninstaller-alias.mjs <rootDir> <exePath>
import fs from 'node:fs';
import path from 'node:path';

const [rootArg, exeArg] = process.argv.slice(2);
if (!rootArg || !exeArg) {
  console.error('用法: node tools/make-uninstaller-alias.mjs <rootDir> <exePath>');
  process.exit(1);
}

const root = path.resolve(rootArg);
const exe = path.resolve(exeArg);
if (!fs.existsSync(exe)) {
  console.error('找不到卸载程序：' + exe);
  process.exit(1);
}

const zh = path.join(root, '卸载 Komi.exe');
fs.copyFileSync(exe, zh);
console.log(`built: ${zh} (${(fs.statSync(zh).size / 1024).toFixed(0)} KB)`);

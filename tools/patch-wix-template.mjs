// 构建前修补 electron-builder 的 WiX 模板（按 WiX 官方界面规范 WixUI_InstallDir）：
//  1) 界面语言 → 简体中文（2052，配合 electron-builder.yml 的 -cultures:zh-CN）
//  2) 默认安装范围 = 每台计算机 → 官方流程里"安装范围"页之后会出现"安装位置"页（可改目录）
//  3) 安装文件夹名固定为中文（中文 productName 会被 sanitize，需单独指定目录名）
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(ROOT, 'node_modules', 'app-builder-lib', 'templates', 'msi', 'template.xml');
const FOLDER = process.env.GO_INSTALL_FOLDER || 'Komi';

if (!existsSync(TEMPLATE)) {
  console.error('WiX 模板不存在，请先 npm install');
  process.exit(1);
}

// 首次运行时保存一份 pristine 备份，之后每次都从它开始打补丁（保证幂等）
const PRISTINE = TEMPLATE + '.pristine';
if (!existsSync(PRISTINE)) {
  await copyFile(TEMPLATE, PRISTINE);
}
await copyFile(PRISTINE, TEMPLATE);

let xml = await readFile(TEMPLATE, 'utf8');
const changes = [];

if (xml.includes('Language="1033"')) {
  xml = xml.replace('Language="1033"', 'Language="2052"');
  changes.push('language=2052');
}

if (xml.includes('Value="WixPerUserFolder"')) {
  xml = xml.replace('Value="WixPerUserFolder"', 'Value="WixPerMachineFolder"');
  changes.push('default-scope=perMachine');
}

if (xml.includes('installationDirectoryWixName')) {
  xml = xml.split('${installationDirectoryWixName}').join(FOLDER);
  changes.push('folder=' + FOLDER);
}

await writeFile(TEMPLATE, xml, 'utf8');
console.log(changes.length ? 'WiX 模板已修补：' + changes.join('、') : 'WiX 模板已是目标状态');

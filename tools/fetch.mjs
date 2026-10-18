// 通用下载器：node tools/fetch.mjs <url> <destPath> [label]
// 走 fetch 流式写入，带进度与大小校验，避免 PowerShell TLS 问题。
import { createWriteStream } from "node:fs";
import { mkdir, stat, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const [url, dest, label = ""] = process.argv.slice(2);
if (!url || !dest) {
  console.error("用法: node tools/fetch.mjs <url> <destPath> [label]");
  process.exit(1);
}

await mkdir(dirname(dest), { recursive: true });
const tmp = dest + ".part";

const started = Date.now();
let lastPct = -1;

try {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "go-game-fetch/1.0" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const total = Number(res.headers.get("content-length") || 0);
  let received = 0;

  const body = Readable.fromWeb(res.body);
  body.on("data", (chunk) => {
    received += chunk.length;
    const pct = total ? Math.floor((received / total) * 100) : 0;
    if (pct !== lastPct && pct % 10 === 0) {
      lastPct = pct;
      const mb = (received / 1048576).toFixed(1);
      const tmb = total ? (total / 1048576).toFixed(1) : "?";
      process.stdout.write(`  ${label} ${pct}% ${mb}/${tmb} MB\n`);
    }
  });

  await pipeline(body, createWriteStream(tmp));
  const { size } = await stat(tmp);
  if (total && size !== total) throw new Error(`大小不符: 期望 ${total}, 实际 ${size}`);
  await rename(tmp, dest);
  console.log(
    `OK  ${dest}  ${(size / 1048576).toFixed(1)} MB  ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
} catch (err) {
  console.error(`FAIL ${label || url}: ${err.message}`);
  process.exit(1);
}

/**
 * 下载源与国内镜像
 *
 * 默认直连官方源；开启"国内镜像"后：
 *   - GitHub Releases 走 gh 代理前缀（多个候选，失败自动换下一个，最后回退直连）
 *   - PyPI 的 NVIDIA wheel 走清华源（元数据用 simple 索引，文件按 packages 路径镜像）
 *
 * 注意：镜像只影响"下载地址"，组件的版本与校验逻辑不变。
 */

/** GitHub 加速前缀（按顺序尝试） */
export const GH_PROXIES = [
  'https://ghfast.top/',
  'https://ghproxy.net/',
  'https://mirror.ghproxy.com/',
];

/** PyPI 镜像（清华） */
export const PYPI_MIRROR = {
  label: '清华 PyPI 镜像',
  simple: 'https://pypi.tuna.tsinghua.edu.cn/simple',
  fileHost: 'https://pypi.tuna.tsinghua.edu.cn',
};

/** 这些域名属于 GitHub Releases，可被代理 */
export function isGithubUrl(url) {
  return /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//i.test(url);
}

/** 这些域名属于 PyPI 文件站，可被镜像 */
export function isPypiFileUrl(url) {
  return /^https:\/\/files\.pythonhosted\.org\//i.test(url);
}

/**
 * 给一个官方 URL 生成"候选地址列表"（按优先级）
 * @param {string} url 官方地址
 * @param {'direct'|'china'} mode
 */
export function candidateUrls(url, mode) {
  if (mode !== 'china') return [url];
  const list = [];
  if (isGithubUrl(url)) {
    for (const p of GH_PROXIES) list.push(p + url);
  } else if (isPypiFileUrl(url)) {
    list.push(url.replace('https://files.pythonhosted.org', PYPI_MIRROR.fileHost));
  }
  list.push(url); // 最后回退直连
  return [...new Set(list)];
}

/**
 * 通过清华 simple 索引解析 PyPI 包的 win_amd64 wheel（国内网络下 pypi.org JSON 可能不可达）
 * @param {string} pkg
 * @returns {Promise<{url:string, bytes:number}|null>}
 */
export async function resolvePypiViaMirror(pkg) {
  const url = `${PYPI_MIRROR.simple}/${pkg}/`;
  const res = await fetch(url, { headers: { 'User-Agent': 'komi-installer/1.0' } });
  if (!res.ok) return null;
  const html = await res.text();

  // 抓取所有 href，筛出 win_amd64 的 whl
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  const wheels = hrefs
    .filter((h) => /win_amd64/i.test(h) && /\.whl/i.test(h))
    .map((href) => {
      const clean = href.split('#')[0]; // 去掉 #sha256=...
      const file = decodeURIComponent(clean.split('/').pop());
      // 版本号在包名与标签之间：nvidia_cudnn_cu12-9.9.0.52-py3-none-win_amd64.whl
      const m = /-(\d+(?:\.\d+)*)-/.exec(file);
      return { href: clean, file, version: m ? m[1].split('.').map(Number) : [0] };
    });
  if (!wheels.length) return null;

  // 按数值版本号取最大（字符串比较会把 9.9 当成比 9.27 新）
  wheels.sort((a, b) => {
    const n = Math.max(a.version.length, b.version.length);
    for (let i = 0; i < n; i++) {
      const d = (a.version[i] ?? 0) - (b.version[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  });
  const pick = wheels[wheels.length - 1];

  // simple 索引里的 href 可能是相对路径，补成绝对地址
  let fileUrl = pick.href;
  if (fileUrl.startsWith('../../')) fileUrl = PYPI_MIRROR.fileHost + '/' + fileUrl.replace(/^(\.\.\/)+/, '');
  else if (!/^https?:/i.test(fileUrl)) fileUrl = new URL(fileUrl, url).href;

  return { url: fileUrl, bytes: 0, filename: pick.file };
}

/**
 * 探测官方源可达性，返回推荐的镜像模式
 * @returns {Promise<{suggest: 'china'|'direct', githubOk:boolean, pypiOk:boolean, ms:{github:number,pypi:number}}>}
 */
export async function probeSources() {
  const test = async (url) => {
    const t0 = Date.now();
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(4000) });
      return { ok: res.ok, ms: Date.now() - t0 };
    } catch {
      return { ok: false, ms: Date.now() - t0 };
    }
  };
  const [gh, pypi] = await Promise.all([test('https://github.com/'), test('https://pypi.org/simple/')]);
  return {
    githubOk: gh.ok,
    pypiOk: pypi.ok,
    ms: { github: gh.ms, pypi: pypi.ms },
    suggest: gh.ok && pypi.ok && gh.ms < 3000 ? 'direct' : 'china',
  };
}

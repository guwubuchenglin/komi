# 更新日志

本项目遵循语义化版本；日期格式为 YYYY-MM-DD。

## 0.4.2 — 2026-10-18

### 新增

- **性能模式（高吞吐 / 省电）**：顶栏「难度」旁新增「性能」下拉框，随时可切，选择会持久化到
  `%APPDATA%\Komi\config\settings.json`（Linux 为 `~/.config/Komi/config/settings.json`）。
  - 高吞吐（默认）：按 CPU 核数分配搜索线程（上限 16）、放大 NN 批次（CUDA 24 / 其它 16）、
    CUDA 上启用 2 个 NN server 线程。
  - 省电：保持原参数（主对局 6 线程 / 观战 4 线程 / batch 8 / 1 个 NN server 线程），发热与风扇更低。
  - 观战是双引擎同跑，线程按核数平分（16 核 → 各 7），不会互相抢 CPU；观战/测速进行中禁止切换。
- 侧栏「系统占用」新增**搜索线程**一行，实时显示当前实际参数（如 `15 线程 · batch 24`）；
  引擎日志同时输出 `搜索参数：15 线程 · batch 24 · NN server 2（性能模式）`。
- 新增 `scripts/test-perf.mjs`（15 项单测）与无界面自检 `electron . --perf-test`
  （吞吐对比 + 引擎重启后局面恢复校验）。

### 改进

- **实测吞吐约翻倍**（RTX 2080 Ti + b18c384nbt，19 路，2000 访问）：
  省电 6 线程 508～611 visits/s → 高吞吐 15 线程 1014～1253 visits/s。
- 观战每手耗时降到 300～430 ms（原更慢），快棋观战的节奏更顺。
- README 新增「性能模式」与「为什么 CUDA 占用率看起来不高」两节，说明 KataGo 的
  GPU 只算短批次、搜索树在 CPU 侧串行，判断优化好坏应看 visits/s 而非 `nvidia-smi` 百分比。

### 修复

- **引擎重启后棋盘失同步**：切换难度会让引擎重启，此前重启后引擎是空盘、界面却有棋子，
  可能下出重复的一手或报「非法着法」。现在引擎管理器记录每一手，重启后自动重放恢复
  （让子局会补回让子）。`--perf-test` 会验证「往已有棋子处落子被拒绝」。
- **同后端换档位不生效**：`setLevel()` 判断「是否需要重启」时比对错了配置指纹（少了 `@后端`），
  导致在 lv7～lv10 之间切换时不走 `kata-set-param` 热切换，访问数停留在上一档
  （例如切到「职业」仍在用 500 访问）。已修正为按「引擎运行中 + 指纹一致」判断。
- 启动瞬间的重绘在 `S.game` 尚未建立时抛 `Cannot read properties of null (reading 'board')`。已加空值保护。

### 变更

- 版本号 `0.4.1` → `0.4.2`；重新产出安装包并清理旧产物：
  - Windows：`dist\Komi-0.4.2.msi`（96.2 MB，四步中文向导：欢迎 → 安装范围 → 目标文件夹 → 安装）
  - Linux：`Komi-0.4.2-linux-x64.tar.gz`（365.2 MB，含 `run.sh` / `install.sh` / `README-LINUX.md`）
- `docs/preview.png` 用新界面重新截图；两份副本（`Komi` / `Komi-linux`）的源码、文档、脚本已同步。

### 升级提示

- 老用户直接装新版覆盖即可；`%APPDATA%\Komi` 里的权重与配置会复用，无需重新下载组件。
- 第一次启动默认就是**高吞吐**；笔记本/核显觉得风扇吵，把「性能」切成「省电」即可，无需重启应用。
- 若之前的配置目录里已有生成的 cfg，新参数会以内容哈希生成新配置，不会读到旧缓存。

---

## 0.4.0 ～ 0.4.1 — 2026-10 上旬

### 新增

- **Windows 精简安装包（MSI，约 96 MB）**：只含程序本体，引擎与神经网络在首次运行时按显卡环境
  可选下载，装完自动进入游戏；安装路径可在向导的「目标文件夹」一页直接选择，组件目录跟随安装目录。
- **AMD / Intel 显卡支持**：后端优先级 CUDA → ROCm → OpenVINO → DirectML → OpenCL → CPU，
  装了什么就自动用更好的那个，换卡不用改配置。
- **首次运行环境检测**：识别显卡型号与驱动，勾选推荐组件（权重、DirectML、OpenCL、OpenVINO、ROCm、
  CUDA 包）一次性装好，之后完全离线。
- **国内下载源开关**：GitHub 代理（ghfast.top / ghproxy.net / mirror.ghproxy.com）+ 清华 PyPI 镜像，
  自动探测给出建议。
- **SGF 读入与复盘**：逐手胜率曲线、恶手标注（含「下个恶手」跳转）、局面重放。
- **AI 对 AI 观战**：双引擎不同档位对打、落子概率（黑/白）、暂停/停止即时生效、观战棋谱可保存；
  「测速对局」批量对战并按胜率估算 ELO 差。
- **让子棋**：2～9 子标准让子，贴目与 AI 档位独立可调。
- 胜率走势图改为**黑白面积占比**（去掉黄线），一眼看出谁领先；侧栏显示 CPU / GPU / 显存占用与当前计算后端。
- 双击启动器 `Komi.exe`（21 KB，带图标）。
- **Linux 版**（独立目录 `Komi-linux`）：x64 免安装 tar.gz，内含 OpenCL 与 CPU 版 KataGo，
  提供 `run.sh` 与 `install.sh`（用户级 `~/.local/opt/komi` 或 `--system` 装到 `/opt/komi`）。

### 修复

- 劫争判定过宽（把所有单子提吃都当成劫）导致观战报「引擎返回非法着法」；改为「被提子仅剩 1 气」才算劫。
- 让子时 `fixed_handicap` 报「Board is not empty」；修正 GTP 命令顺序（boardsize → clear_board → komi → handicap）并串行化。
- 观战模式保存棋谱按钮不可点（`updateButtons()` 漏调用）。
- 组件齐全但只有可选组件缺失时仍弹安装向导；改为只拦必需组件。
- MSI 中文界面触发 `LGHT0311` 代码页错误；改为 WiX 官方 `WixUI_InstallDir` + `-cultures:zh-CN` + Language 2052。

---

## 0.4.0 之前

- 内置 KataGo（GTP）引擎与 `b18c384nbt` 主力网络、`b18c384nbt-humanv0` 拟人网络。
- 10 档难度：入门 20 级 → 新手 15 级 → 初级 10 级 → 中级 5 级 → 中高 2 级 → 高级 1 段 →
  低段 3 段 → 高段 5 段 → 职业 → 超人；弱档用 human SL 拟人模型 + 温度与延迟，强档用标准网络 + 递增访问。
- 候选点面板、落子概率热图、形势图（ownership）、手数显示、悔棋、停一手、认输、形势判断、保存 SGF。
- 规则引擎单测（劫争/提子/禁入点等）与 SGF 单测；`--selftest` / `--handicap` / `--spectate` /
  `--review` / `--ui` 无界面自检，以及 `--shot` 自动截图。

---

## 已知问题

- 上游 GitHub 仓库曾返回 `Repository not found`，推送需先重建仓库；本地提交完整。
- 早期卸载残留的 ARP 项（`围棋 0.3.3`）需管理员权限手动删除：
  `reg delete "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{4B1548E6-793C-4D1D-9A16-50043C596E91}" /f`
- Linux 包为目录 + tar.gz 形式，未提供 `.AppImage` / `.deb`（需要 WSL 或 Docker 环境构建）。

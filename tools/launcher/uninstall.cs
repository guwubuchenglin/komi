// Komi 卸载程序（便携版 / 免安装目录专用）
// 编译：csc /target:winexe /win32icon:assets\app.ico uninstall.cs
//
// 行为：
//   1. 弹窗确认，可选「同时删除 AI 组件与神经网络（%APPDATA%\Komi）」
//   2. 结束正在运行的 Komi / katago 进程
//   3. 删除桌面与开始菜单快捷方式
//   4. 把自己复制到临时目录，再删除程序目录（自己删自己做不到，必须借道临时副本）
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

class Uninstaller
{
    const string AppName = "Komi";

    [STAThread]
    static int Main(string[] args)
    {
        bool silent = HasFlag(args, "--silent") || HasFlag(args, "/s") || HasFlag(args, "/S");

        // 第二阶段：从临时目录运行，负责真正删除
        string target = ArgValue(args, "--target");
        if (!string.IsNullOrEmpty(target))
        {
            bool stripData = ArgValue(args, "--remove-data") == "1";
            int code = DoRemove(target, stripData, silent);
            SelfDeleteLater();
            return code;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        string baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        bool looksLikeKomi =
            File.Exists(Path.Combine(baseDir, "Komi.exe")) ||
            File.Exists(Path.Combine(baseDir, "komi.exe")) ||
            Directory.Exists(Path.Combine(baseDir, "resources"));

        string dataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            AppName);

        bool removeData;
        if (silent || HasFlag(args, "--yes") || HasFlag(args, "/y"))
        {
            // 注意：只有 --remove-data 1 / --remove-data true 才算要删组件，
            // 写成 --remove-data 0 绝不能误删用户已下载的神经网络
            string v = ArgValue(args, "--remove-data");
            removeData = v != null && (v == "1" || v.Equals("true", StringComparison.OrdinalIgnoreCase));
        }
        else
        {
            using (var form = new UninstallForm(baseDir, dataDir, looksLikeKomi))
            {
                if (form.ShowDialog() != DialogResult.OK) return 0;
                removeData = form.RemoveData;
            }
        }

        KillProcesses(baseDir);
        RemoveShortcuts();

        // 借道临时目录完成「删掉自己所在的目录」
        string tmp = Path.Combine(Path.GetTempPath(), "komi-uninstall-" + Guid.NewGuid().ToString("N").Substring(0, 8));
        Directory.CreateDirectory(tmp);
        string copy = Path.Combine(tmp, "uninstall-tmp.exe");
        try
        {
            File.Copy(Application.ExecutablePath, copy, true);
        }
        catch (Exception ex)
        {
            if (!silent)
                MessageBox.Show("准备卸载失败：" + ex.Message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        var psi = new ProcessStartInfo(copy)
        {
            Arguments =
                "--target \"" + baseDir + "\" --remove-data " + (removeData ? "1" : "0") + (silent ? " --silent" : ""),
            UseShellExecute = false,
        };
        Process.Start(psi);

        if (removeData) TryDeleteDir(dataDir);
        return 0;
    }

    static bool HasFlag(string[] args, string flag)
    {
        foreach (var a in args)
        {
            if (string.Equals(a, flag, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    static string ArgValue(string[] args, string key)
    {
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], key, StringComparison.OrdinalIgnoreCase)) return args[i + 1];
        }
        return null;
    }

    static int DoRemove(string dir, bool removeData, bool silent)
    {
        for (int attempt = 0; attempt < 5; attempt++)
        {
            try
            {
                if (Directory.Exists(dir)) Directory.Delete(dir, true);
                if (Directory.Exists(dir)) throw new IOException("目录仍在");
                if (!silent)
                    MessageBox.Show(
                        "Komi 已卸载。" + (removeData ? "\n\nAI 组件与神经网络也已删除。" : "\n\nAI 组件保留在 %APPDATA%\\Komi，下次安装可直接复用。"),
                        AppName,
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information);
                return 0;
            }
            catch (Exception)
            {
                Thread.Sleep(600);
            }
        }
        try
        {
            // 兜底：交给系统命令删（有时资源管理器句柄会短暂占用）
            var psi = new ProcessStartInfo("cmd.exe", "/c rd /s /q \"" + dir + "\"")
            {
                WindowStyle = ProcessWindowStyle.Hidden,
                CreateNoWindow = true,
            };
            Process.Start(psi).WaitForExit(15000);
        }
        catch
        {
            // 忽略
        }
        if (!silent)
            MessageBox.Show("部分文件未能删除，可能仍被占用。请关闭所有 Komi 窗口后手动删除：\n" + dir, AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        return Directory.Exists(dir) ? 1 : 0;
    }

    static void TryDeleteDir(string dir)
    {
        try
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }
        catch
        {
            // 忽略：可能被占用，第二阶段会再试
        }
    }

    static void KillProcesses(string baseDir)
    {
        string[] names = { "Komi", "komi", "katago", "electron" };
        foreach (var name in names)
        {
            foreach (var p in Process.GetProcessesByName(name))
            {
                try
                {
                    // 只结束本目录下的进程，别误伤其他 electron 应用
                    string path = null;
                    try { path = p.MainModule.FileName; } catch { }
                    if (path == null || path.StartsWith(baseDir, StringComparison.OrdinalIgnoreCase))
                    {
                        p.Kill();
                        p.WaitForExit(4000);
                    }
                }
                catch
                {
                    // 忽略权限问题
                }
            }
        }
        Thread.Sleep(400);
    }

    static void RemoveShortcuts()
    {
        var dirs = new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
            Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs)),
            Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms),
        };
        foreach (var dir in dirs)
        {
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) continue;
            try
            {
                foreach (var lnk in Directory.GetFiles(dir, "*.lnk", SearchOption.AllDirectories))
                {
                    string name = Path.GetFileNameWithoutExtension(lnk);
                    if (name.StartsWith("Komi", StringComparison.OrdinalIgnoreCase) ||
                        name.StartsWith("围棋", StringComparison.OrdinalIgnoreCase))
                    {
                        try { File.Delete(lnk); } catch { }
                    }
                }
            }
            catch
            {
                // 忽略
            }
        }
    }

    static void SelfDeleteLater()
    {
        try
        {
            string self = Application.ExecutablePath;
            var psi = new ProcessStartInfo("cmd.exe", "/c ping -n 3 127.0.0.1 >nul & del /f /q \"" + self + "\"")
            {
                WindowStyle = ProcessWindowStyle.Hidden,
                CreateNoWindow = true,
            };
            Process.Start(psi);
        }
        catch
        {
            // 忽略
        }
    }
}

class UninstallForm : Form
{
    public bool RemoveData { get; private set; }

    public UninstallForm(string baseDir, string dataDir, bool looksLikeKomi)
    {
        Text = "卸载 Komi / Uninstall Komi";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new System.Drawing.Size(520, looksLikeKomi ? 300 : 340);
        Font = new System.Drawing.Font("Microsoft YaHei UI", 9F);

        var title = new Label
        {
            Text = "卸载 Komi（内置 KataGo 的本地 AI 围棋）",
            Font = new System.Drawing.Font("Microsoft YaHei UI", 11F, System.Drawing.FontStyle.Bold),
            Location = new System.Drawing.Point(20, 18),
            Size = new System.Drawing.Size(470, 26),
        };
        Controls.Add(title);

        var path = new Label
        {
            Text = "程序目录：" + baseDir,
            ForeColor = System.Drawing.Color.DimGray,
            Location = new System.Drawing.Point(20, 48),
            Size = new System.Drawing.Size(470, 40),
        };
        Controls.Add(path);

        var tip = new Label
        {
            Text = looksLikeKomi
                ? "将删除上面的程序目录与桌面/开始菜单快捷方式。\n"
                    + "AI 组件与神经网络默认保留（约 1.5 GB，位于 " + dataDir + "），重装可复用。"
                : "⚠ 这个目录里没找到 Komi 的程序文件，确认后再继续。",
            Location = new System.Drawing.Point(20, 92),
            Size = new System.Drawing.Size(470, 56),
            ForeColor = looksLikeKomi ? System.Drawing.Color.Black : System.Drawing.Color.Firebrick,
        };
        Controls.Add(tip);

        var chk = new CheckBox
        {
            Text = "同时删除 AI 组件与神经网络（" + dataDir + "）",
            Location = new System.Drawing.Point(20, 156),
            Size = new System.Drawing.Size(470, 40),
            Checked = false,
        };
        chk.CheckedChanged += (s, e) => RemoveData = chk.Checked;
        Controls.Add(chk);

        var note = new Label
        {
            Text = "提示：如果这是用 MSI 安装包装的，请改用「设置 → 应用和功能」卸载，\n那里才会同步清理注册表与卸载项。",
            ForeColor = System.Drawing.Color.DimGray,
            Location = new System.Drawing.Point(20, 200),
            Size = new System.Drawing.Size(470, 40),
        };
        Controls.Add(note);

        var ok = new Button
        {
            Text = "卸载",
            DialogResult = DialogResult.OK,
            Location = new System.Drawing.Point(300, ClientSize.Height - 56),
            Size = new System.Drawing.Size(96, 32),
        };
        var cancel = new Button
        {
            Text = "取消",
            DialogResult = DialogResult.Cancel,
            Location = new System.Drawing.Point(404, ClientSize.Height - 56),
            Size = new System.Drawing.Size(96, 32),
        };
        Controls.Add(ok);
        Controls.Add(cancel);
        AcceptButton = ok;
        CancelButton = cancel;
    }
}

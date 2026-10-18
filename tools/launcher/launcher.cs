// Komi —— 双击启动器
// 编译：csc /target:winexe /win32icon:assets\app.ico launcher.cs
using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');

        string electron = Path.Combine(baseDir, @"node_modules\electron\dist\electron.exe");
        if (!File.Exists(electron))
        {
            MessageBox.Show(
                "未找到 Electron 运行环境。\n\n请先在本目录下打开命令行执行：\n    npm install\n\n完成后再双击本程序。",
                "Komi · 启动失败",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return 1;
        }

        string katago = Path.Combine(baseDir, @"engine\katago.exe");
        string katagoCpu = Path.Combine(baseDir, @"engine\cpu\katago.exe");
        if (!File.Exists(katago) && !File.Exists(katagoCpu))
        {
            MessageBox.Show(
                "未找到 KataGo 引擎。\n\n请确认 engine 目录完整（katago.exe 与 weights 权重）。",
                "Komi · 启动失败",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return 1;
        }

        try
        {
            var psi = new ProcessStartInfo(electron, "\"" + baseDir + "\"");
            psi.WorkingDirectory = baseDir;
            psi.UseShellExecute = false;
            Process.Start(psi);
            return 0;
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "启动失败：" + ex.Message,
                "Komi",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }
    }
}

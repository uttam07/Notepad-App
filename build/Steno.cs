/* Steno — lightweight desktop shell (WebView2).
   Frameless window: no OS title bar; min/max/close live in the app's
   own top bar and drive this host via chrome.webview.postMessage.
   App assets + WebView2 interop DLLs are embedded as resources and
   extracted to %LOCALAPPDATA%\Steno on first run.
   The app is served from https://steno.local (virtual host), a secure
   origin, so window.showSaveFilePicker works. */
using System;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

static class Program
{
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool ReleaseCapture();
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);

    public const int WM_NCLBUTTONDOWN = 0xA1;
    public static readonly IntPtr HTCAPTION = (IntPtr)2;

    static readonly string DataDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Steno");
    static readonly string AppDir = Path.Combine(DataDir, "app");
    static Mutex mutex;

    [STAThread]
    static void Main()
    {
        bool created;
        mutex = new Mutex(true, "StenoQuietNotepad.SingleInstance", out created);
        if (!created) return; // already running

        SetProcessDPIAware();

        // Load embedded managed assemblies (WebView2 interop) from resources
        AppDomain.CurrentDomain.AssemblyResolve += delegate (object s, ResolveEventArgs e)
        {
            string name = new AssemblyName(e.Name).Name;
            using (Stream st = Assembly.GetExecutingAssembly().GetManifestResourceStream(name + ".dll"))
            {
                if (st == null) return null;
                byte[] buf = new byte[st.Length];
                st.Read(buf, 0, buf.Length);
                return Assembly.Load(buf);
            }
        };

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Run();
    }

    // Separate non-inlined method so WebView2 types are not JIT-touched
    // before the AssemblyResolve handler above is registered.
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    static void Run()
    {
        try
        {
            // Native WebView2 loader must exist on disk for LoadLibrary
            string loader = Path.Combine(DataDir, "WebView2Loader.dll");
            ExtractResource("WebView2Loader.dll", loader);
            SetDllDirectory(Path.GetDirectoryName(loader));

            // App assets
            string[] assets = { "app/index.html", "app/css/style.css", "app/js/app.js", "app/js/highlighter.js" };
            foreach (string res in assets)
                ExtractResource(res, Path.Combine(DataDir, res.Replace('/', Path.DirectorySeparatorChar)));

            Application.Run(new StenoForm(AppDir));
        }
        catch (Exception ex)
        {
            MessageBox.Show("Steno failed to start.\n\n" + ex.Message,
                "Steno", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    [DllImport("kernel32.dll")] static extern bool SetDllDirectory(string path);

    static void ExtractResource(string res, string dest)
    {
        using (Stream st = Assembly.GetExecutingAssembly().GetManifestResourceStream(res))
        {
            if (st == null) throw new FileNotFoundException("Missing embedded resource: " + res);
            Directory.CreateDirectory(Path.GetDirectoryName(dest));
            using (FileStream fs = File.Create(dest)) st.CopyTo(fs);
        }
    }
}

class StenoForm : Form
{
    const int WM_NCHITTEST = 0x84;
    const int WM_GETMINMAXINFO = 0x24;
    const int BORDER = 5;
    const int MONITOR_DEFAULTTONEAREST = 2;

    // Windows 11 rounded-corner + frame-colour attributes (no-ops on Windows 10)
    const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    const int DWMWA_BORDER_COLOR = 34;
    const int DWMWCP_ROUND = 2;

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    [DllImport("user32.dll")]
    static extern IntPtr MonitorFromWindow(IntPtr hwnd, int flags);

    [DllImport("user32.dll")]
    static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO mi);

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor, rcWork;
        public int dwFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MINMAXINFO
    {
        public POINT ptReserved, ptMaxSize, ptMaxPosition, ptMinTrackSize, ptMaxTrackSize;
    }

    static readonly IntPtr HTCLIENT = (IntPtr)1;
    static readonly IntPtr HTLEFT = (IntPtr)10, HTRIGHT = (IntPtr)11;
    static readonly IntPtr HTTOP = (IntPtr)12, HTTOPLEFT = (IntPtr)13, HTTOPRIGHT = (IntPtr)14;
    static readonly IntPtr HTBOTTOM = (IntPtr)15, HTBOTTOMLEFT = (IntPtr)16, HTBOTTOMRIGHT = (IntPtr)17;

    static readonly Color PaperEdge = Color.FromArgb(0xfb, 0xfa, 0xf9);
    static readonly Color NightEdge = Color.FromArgb(0x1c, 0x1c, 0x1f);
    static readonly Color PaperBorder = Color.FromArgb(0xe1, 0xdf, 0xda);
    static readonly Color NightBorder = Color.FromArgb(0x3a, 0x3a, 0x40);

    Color borderColor = PaperBorder;
    bool dwmRounded;   // true once Windows agrees to round the corners for us

    readonly string appDir;
    Microsoft.Web.WebView2.WinForms.WebView2 wv;

    public StenoForm(string appDir)
    {
        this.appDir = appDir;
        Text = "Steno — quiet notepad";
        Width = 1200;
        Height = 800;
        MinimumSize = new Size(640, 480);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.None;   // no OS title bar
        Padding = new Padding(BORDER); // resize grip frame
        BackColor = PaperEdge;
        SetStyle(ControlStyles.ResizeRedraw, true); // keep the hairline frame crisp while resizing
        using (Stream ico = Assembly.GetExecutingAssembly().GetManifestResourceStream("app.ico"))
            if (ico != null) Icon = new Icon(ico);

        wv = new Microsoft.Web.WebView2.WinForms.WebView2();
        wv.Dock = DockStyle.Fill;
        Controls.Add(wv);

        Shown += async delegate (object s, EventArgs e)
        {
            try
            {
                Microsoft.Web.WebView2.Core.CoreWebView2Environment env =
                    await Microsoft.Web.WebView2.Core.CoreWebView2Environment.CreateAsync(
                        null, Path.Combine(ProgramDataDir(), "webview"));
                await wv.EnsureCoreWebView2Async(env);
                // WebView2 silently denies file-system write permission by default,
                // which breaks File System Access save-back. Allow it.
                wv.CoreWebView2.PermissionRequested += delegate (object ps, Microsoft.Web.WebView2.Core.CoreWebView2PermissionRequestedEventArgs args)
                {
                    args.State = Microsoft.Web.WebView2.Core.CoreWebView2PermissionState.Allow;
                    args.Handled = true;
                };
                wv.CoreWebView2.SetVirtualHostNameToFolderMapping(
                    "steno.local", appDir,
                    Microsoft.Web.WebView2.Core.CoreWebView2HostResourceAccessKind.Allow);
                wv.WebMessageReceived += OnWebMessage;
                wv.Source = new Uri("https://steno.local/index.html");
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "Steno needs the Microsoft Edge WebView2 Runtime (preinstalled on Windows 11).\n\n" + ex.Message,
                    "Steno", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        };
    }

    static string ProgramDataDir()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Steno");
    }

    void OnWebMessage(object s, Microsoft.Web.WebView2.Core.CoreWebView2WebMessageReceivedEventArgs e)
    {
        string msg;
        try { msg = e.TryGetWebMessageAsString(); } catch { return; }
        if (msg == "min") WindowState = FormWindowState.Minimized;
        else if (msg == "max")
        {
            WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
        }
        else if (msg == "close") Close();
        else if (msg == "drag" && WindowState != FormWindowState.Maximized)
        {
            Program.ReleaseCapture();
            Program.SendMessage(Handle, Program.WM_NCLBUTTONDOWN, Program.HTCAPTION, IntPtr.Zero);
        }
        else if (msg == "drag") WindowState = FormWindowState.Normal;
        else if (msg == "theme:night") { BackColor = NightEdge; borderColor = NightBorder; ApplyBorderColor(); Invalidate(); }
        else if (msg == "theme:paper") { BackColor = PaperEdge; borderColor = PaperBorder; ApplyBorderColor(); Invalidate(); }
    }

    // Ask Windows 11 for rounded corners and let it paint the 1px frame, so the
    // border follows the corner arc instead of being clipped square by it.
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        int pref = DWMWCP_ROUND;
        dwmRounded = DwmSetWindowAttribute(Handle, DWMWA_WINDOW_CORNER_PREFERENCE, ref pref, sizeof(int)) == 0;
        ApplyBorderColor();
    }

    void ApplyBorderColor()
    {
        if (!dwmRounded || !IsHandleCreated) return;
        int bgr = borderColor.R | (borderColor.G << 8) | (borderColor.B << 16);
        DwmSetWindowAttribute(Handle, DWMWA_BORDER_COLOR, ref bgr, sizeof(int));
    }

    // A borderless window maximizes over the whole monitor by default, hiding the
    // taskbar. Clamp it to the work area of whichever monitor the window is on.
    // ptMaxPosition is monitor-relative, which is why virtual-desktop coordinates
    // (e.g. a second screen at a negative origin) must not be used directly here.
    void ClampMaximizeToWorkArea(IntPtr hwnd, IntPtr lParam)
    {
        IntPtr mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if (mon == IntPtr.Zero) return;

        MONITORINFO mi = new MONITORINFO();
        mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
        if (!GetMonitorInfo(mon, ref mi)) return;

        MINMAXINFO mmi = (MINMAXINFO)Marshal.PtrToStructure(lParam, typeof(MINMAXINFO));
        mmi.ptMaxPosition.X = mi.rcWork.Left - mi.rcMonitor.Left;
        mmi.ptMaxPosition.Y = mi.rcWork.Top - mi.rcMonitor.Top;
        mmi.ptMaxSize.X = mi.rcWork.Right - mi.rcWork.Left;
        mmi.ptMaxSize.Y = mi.rcWork.Bottom - mi.rcWork.Top;
        // Windows clamps a maximized borderless window to the track size, which it
        // derives from the whole virtual desktop, so it must be capped as well.
        mmi.ptMaxTrackSize.X = mmi.ptMaxSize.X;
        mmi.ptMaxTrackSize.Y = mmi.ptMaxSize.Y;
        Marshal.StructureToPtr(mmi, lParam, false);
    }

    // Fallback frame for Windows 10, where DWM won't round the corners or paint
    // the border for us. Maximized windows drop it, matching Windows' behaviour.
    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        if (dwmRounded || WindowState == FormWindowState.Maximized) return;
        using (Pen pen = new Pen(borderColor))
        {
            Rectangle r = ClientRectangle;
            r.Width -= 1;
            r.Height -= 1;
            e.Graphics.DrawRectangle(pen, r);
        }
    }

    // Resize borders for the frameless window (the web view fills the
    // client area, so only the thin Padding frame belongs to the form)
    protected override void WndProc(ref Message m)
    {
        base.WndProc(ref m);
        if (m.Msg == WM_GETMINMAXINFO) { ClampMaximizeToWorkArea(m.HWnd, m.LParam); return; }
        if (m.Msg != WM_NCHITTEST || m.Result != HTCLIENT) return;
        if (WindowState == FormWindowState.Maximized) return;
        Point p = PointToClient(new Point(m.LParam.ToInt32() & 0xFFFF, (m.LParam.ToInt32() >> 16) & 0xFFFF));
        bool l = p.X <= BORDER, r = p.X >= ClientSize.Width - BORDER;
        bool t = p.Y <= BORDER, b = p.Y >= ClientSize.Height - BORDER;
        if (l && t) m.Result = HTTOPLEFT;
        else if (r && t) m.Result = HTTOPRIGHT;
        else if (l && b) m.Result = HTBOTTOMLEFT;
        else if (r && b) m.Result = HTBOTTOMRIGHT;
        else if (l) m.Result = HTLEFT;
        else if (r) m.Result = HTRIGHT;
        else if (t) m.Result = HTTOP;
        else if (b) m.Result = HTBOTTOM;
    }
}

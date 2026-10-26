using System;
using System.Collections.Generic;
using System.Threading;
using System.Runtime.InteropServices;
using System.Text;

namespace FluentFlyoutDocker
{
    class Program
    {
        [DllImport("user32.dll", EntryPoint = "FindWindowExW", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);

        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);

        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr GetParent(IntPtr hWnd);

        [DllImport("user32.dll", ExactSpelling = true)]
        static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);
        const uint GA_PARENT = 1;
        const uint GA_ROOT = 2;

        [DllImport("user32.dll")]
        static extern IntPtr WindowFromPoint(POINT point);

        [DllImport("user32.dll", SetLastError = true)]
        static extern int GetWindowLong(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", SetLastError = true)]
        static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern bool SetProp(IntPtr hwnd, string name, IntPtr value);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr GetProp(IntPtr hwnd, string name);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr RemoveProp(IntPtr hwnd, string name);

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("gdi32.dll")]
        static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
        [DllImport("user32.dll")]
        static extern int GetWindowRgn(IntPtr hwnd, IntPtr region);
        [DllImport("user32.dll")]
        static extern int SetWindowRgn(IntPtr hwnd, IntPtr region, bool redraw);
        [DllImport("gdi32.dll")]
        static extern bool PtInRegion(IntPtr region, int x, int y);
        [DllImport("gdi32.dll")]
        static extern int GetRgnBox(IntPtr region, out RECT rect);
        [DllImport("gdi32.dll")]
        static extern bool DeleteObject(IntPtr value);
        [DllImport("dwmapi.dll")]
        static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
        [DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
        const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
        [DllImport("winmm.dll")]
        static extern uint timeBeginPeriod(uint period);

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

        static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool ScreenToClient(IntPtr hWnd, ref POINT lpPoint);

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);

        [DllImport("user32.dll")]
        static extern bool GetCursorPos(out POINT lpPoint);

        [DllImport("user32.dll")]
        static extern short GetAsyncKeyState(int vKey);

        const int VK_LBUTTON = 0x01;

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr OpenWindowStation(string lpszWinSta, bool fInherit, uint dwDesiredAccess);

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool SetProcessWindowStation(IntPtr hWinSta);

        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool SetThreadDesktop(IntPtr hDesktop);

        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);

        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr MonitorFromRect(ref RECT lprc, uint dwFlags);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        static extern uint GetDpiForWindow(IntPtr hWnd);

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MONITORINFO
        {
            public uint cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public uint dwFlags;
        }

        const uint MONITOR_DEFAULTTONEAREST = 2;

        const int GWL_STYLE = -16;
        const int GWL_EXSTYLE = -20;
        const int WS_POPUP = unchecked((int)0x80000000);
        const int WS_CHILD = 0x40000000;
        const int WS_EX_NOACTIVATE = 0x08000000;
        const int WS_EX_TOOLWINDOW = 0x00000080;
        const int WS_EX_APPWINDOW = 0x00040000;

        const uint SWP_NOSIZE = 0x0001;
        const uint SWP_NOMOVE = 0x0002;
        const uint SWP_NOZORDER = 0x0004;
        const uint SWP_NOACTIVATE = 0x0010;
        const uint SWP_FRAMECHANGED = 0x0020;
        const uint SWP_SHOWWINDOW = 0x0040;

        static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        static readonly IntPtr HWND_TOP = IntPtr.Zero;

        static int GetRightAnchor(IntPtr taskbarHwnd, int taskbarClientWidth)
        {
            IntPtr trayHwnd = FindWindowEx(taskbarHwnd, IntPtr.Zero, "TrayNotifyWnd", null);
            if (trayHwnd != IntPtr.Zero && IsWindow(trayHwnd))
            {
                RECT trayRect;
                if (GetWindowRect(trayHwnd, out trayRect))
                {
                    POINT pt = new POINT();
                    pt.X = trayRect.Left;
                    pt.Y = trayRect.Top;
                    if (ScreenToClient(taskbarHwnd, ref pt))
                    {
                        if (pt.X > 0 && pt.X <= taskbarClientWidth)
                        {
                            return pt.X;
                        }
                    }
                }
            }

            return taskbarClientWidth;
        }

        static IntPtr ParseHwnd(string s)
        {
            if (string.IsNullOrEmpty(s)) return IntPtr.Zero;
            long val = s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
                ? Convert.ToInt64(s.Substring(2), 16)
                : Convert.ToInt64(s);
            return new IntPtr(val);
        }

        static int GetWindowDpi(IntPtr hWnd)
        {
            try
            {
                uint dpi = GetDpiForWindow(hWnd);
                if (dpi > 0) return (int)dpi;
            }
            catch
            {
                // 이전 Windows 버전 호환 폴백
            }
            return 96;
        }

        // 다중 모니터를 고려한 대상 작업표시줄 탐색
        static IntPtr FindTargetTaskbar(RECT? targetMonitorRect)
        {
            List<IntPtr> taskbars = new List<IntPtr>();

            EnumWindows(delegate (IntPtr hWnd, IntPtr lParam)
            {
                StringBuilder sb = new StringBuilder(64);
                GetClassName(hWnd, sb, sb.Capacity);
                string cls = sb.ToString();
                if (cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd")
                {
                    taskbars.Add(hWnd);
                }
                return true;
            }, IntPtr.Zero);

            if (taskbars.Count == 0)
            {
                return IntPtr.Zero;
            }

            // 모니터 영역이 지정된 경우 해당 모니터에 위치한 작업표시줄 선택
            if (targetMonitorRect.HasValue)
            {
                RECT monRect = targetMonitorRect.Value;
                IntPtr targetMon = MonitorFromRect(ref monRect, MONITOR_DEFAULTTONEAREST);

                for (int i = 0; i < taskbars.Count; i++)
                {
                    IntPtr tb = taskbars[i];
                    IntPtr tbMon = MonitorFromWindow(tb, MONITOR_DEFAULTTONEAREST);
                    if (tbMon == targetMon)
                    {
                        return tb;
                    }
                }
            }

            // 폴백: 메인 작업표시줄(Shell_TrayWnd) 우선
            for (int i = 0; i < taskbars.Count; i++)
            {
                StringBuilder sb = new StringBuilder(64);
                GetClassName(taskbars[i], sb, sb.Capacity);
                if (sb.ToString() == "Shell_TrayWnd")
                {
                    return taskbars[i];
                }
            }

            return taskbars[0];
        }

        static bool IsForegroundFullscreen(IntPtr widgetHwnd)
        {
            IntPtr fg = GetForegroundWindow();
            if (fg == IntPtr.Zero) return false;

            StringBuilder classNameBuf = new StringBuilder(256);
            GetClassName(fg, classNameBuf, classNameBuf.Capacity);
            string className = classNameBuf.ToString();

            if (className == "Progman" || className == "WorkerW" || className == "Shell_TrayWnd" || className == "Shell_SecondaryTrayWnd")
            {
                return false;
            }

            RECT winRect;
            if (!GetWindowRect(fg, out winRect)) return false;

            IntPtr hMon = MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);

            if (widgetHwnd != IntPtr.Zero && IsWindow(widgetHwnd))
            {
                IntPtr widgetMon = MonitorFromWindow(widgetHwnd, MONITOR_DEFAULTTONEAREST);
                if (widgetMon != hMon) return false;
            }

            MONITORINFO mi = new MONITORINFO();
            mi.cbSize = (uint)Marshal.SizeOf(typeof(MONITORINFO));
            if (!GetMonitorInfo(hMon, ref mi)) return false;

            return winRect.Left <= mi.rcMonitor.Left
                && winRect.Top <= mi.rcMonitor.Top
                && winRect.Right >= mi.rcMonitor.Right
                && winRect.Bottom >= mi.rcMonitor.Bottom;
        }

        // 커서가 위젯 영역 안이고, 그 지점의 최상위 창이 작업표시줄(=위젯이 실제로 보이는 상태)인지
        static bool IsCursorOnWidget(IntPtr widget, IntPtr taskbar)
        {
            POINT p;
            RECT r;
            return GetCursorPos(out p) && GetWindowRect(widget, out r)
                && p.X >= r.Left && p.X < r.Right && p.Y >= r.Top && p.Y < r.Bottom
                && GetAncestor(WindowFromPoint(p), GA_ROOT) == taskbar;
        }


        // serve 모드에서는 명령마다 출력을 모아 한 줄 응답으로 보낸다(스레드별 출력 대상).
        [ThreadStatic] static StringBuilder captured;
        [ThreadStatic] static string streamTag;
        static readonly object outLock = new object();
        static IntPtr desktopHandle = IntPtr.Zero;

        static void Emit(string line)
        {
            if (captured != null) { captured.Append(line.Replace('\n', ' ').Replace('\r', ' ')).Append('\u001e'); return; }
            if (streamTag != null) { WriteLocked("S " + streamTag + " " + line); return; }
            Console.WriteLine(line);
        }
        static void EmitFlush() { if (captured == null && streamTag == null) Console.Out.Flush(); }
        static void WriteLocked(string line)
        {
            lock (outLock) { Console.Out.WriteLine(line); Console.Out.Flush(); }
        }

        [DllImport("user32.dll")]
        static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        // Windows 11은 창 없는 백그라운드 프로세스의 타이머를 늦춘다(전력 제한). 마우스 감시가 1초 넘게 멈추면
        // 짧은 누름·끌기를 통째로 놓치므로 이 프로세스는 실행 속도·타이머 해상도 제한에서 뺀다.
        [StructLayout(LayoutKind.Sequential)]
        struct PROCESS_POWER_THROTTLING_STATE { public uint Version; public uint ControlMask; public uint StateMask; }
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetProcessInformation(IntPtr hProcess, int infoClass, ref PROCESS_POWER_THROTTLING_STATE info, int size);
        [DllImport("kernel32.dll")]
        static extern IntPtr GetCurrentProcess();
        static void OptOutOfPowerThrottling()
        {
            try
            {
                PROCESS_POWER_THROTTLING_STATE st = new PROCESS_POWER_THROTTLING_STATE { Version = 1, ControlMask = 0x1 | 0x4, StateMask = 0 };
                SetProcessInformation(GetCurrentProcess(), 4, ref st, Marshal.SizeOf(typeof(PROCESS_POWER_THROTTLING_STATE)));
            }
            catch { }
        }
        const uint WM_NCACTIVATE = 0x0086;
        [DllImport("user32.dll")]
        static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint crKey, byte bAlpha, uint dwFlags);
        const int WS_EX_LAYERED = 0x00080000;
        const uint LWA_ALPHA = 0x2;

        // 상주 모드: 프로세스 생성(약 150ms)을 명령마다 반복하지 않도록 stdin으로 명령을 받는다.
        // 입력: "<id> <action> <args...>"  출력: "R <id> <exitCode> <출력 줄들을 0x1E로 이은 것>"
        // pointerwatch처럼 계속 출력하는 명령은 별도 스레드에서 "S <id> <줄>"을 보낸 뒤 R로 끝낸다.
        static int Serve()
        {
            WriteLocked("READY");
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                string[] parts = line.Trim().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length < 2) continue;
                string id = parts[0];
                string[] cmd = new string[parts.Length - 1];
                Array.Copy(parts, 1, cmd, 0, cmd.Length);
                if (cmd[0] == "pointerwatch")
                {
                    Thread t = new Thread(delegate ()
                    {
                        if (desktopHandle != IntPtr.Zero) SetThreadDesktop(desktopHandle);
                        streamTag = id;
                        int code;
                        try { code = RunAction(cmd); } catch { code = 99; }
                        WriteLocked("R " + id + " " + code + " ");
                    });
                    t.IsBackground = true;
                    t.Start();
                    continue;
                }
                captured = new StringBuilder();
                int exit;
                try { exit = RunAction(cmd); }
                catch (Exception ex) { captured.Append("ERROR: " + ex.Message); exit = 99; }
                string output = captured.ToString().TrimEnd('\u001e');
                captured = null;
                WriteLocked("R " + id + " " + exit + " " + output);
            }
            return 0;
        }

        static int RunAction(string[] args)
        {
            try
            {
                SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            }
            catch { }

            if (args.Length < 1) return 1;

            string action = args[0].ToLower();

            // corner <hwnd> <round|none>: DWM 둥근 모서리. SetWindowRgn과 달리 아크릴 backdrop도 함께 자른다.
            if (action == "corner" && args.Length >= 3)
            {
                int preference = args[2] == "round" ? 2 : 1;
                return DwmSetWindowAttribute(ParseHwnd(args[1]), DWMWA_WINDOW_CORNER_PREFERENCE, ref preference, 4) == 0 ? 0 : 1;
            }

            // ncactivate <hwnd>: Windows 11은 활성 창에만 아크릴 흐림을 그린다. 비활성 상태에서도 활성처럼 그리게 한다.
            if (action == "ncactivate" && args.Length >= 2)
            {
                IntPtr hwnd = ParseHwnd(args[1]);
                if (!IsWindow(hwnd)) return 4;
                SendMessage(hwnd, WM_NCACTIVATE, new IntPtr(1), IntPtr.Zero);
                return 0;
            }

            // backdrop <hwnd> <none|acrylic>: DWM 시스템 backdrop만 바꾼다. 프레임 확장은 그대로라 none이면 흐림 없이 비친다.
            if (action == "backdrop" && args.Length >= 3)
            {
                IntPtr hwnd = ParseHwnd(args[1]);
                if (!IsWindow(hwnd)) return 4;
                int type = args[2] == "acrylic" ? 3 : 1;
                return DwmSetWindowAttribute(hwnd, 38, ref type, 4) == 0 ? 0 : 1;
            }

            // usableright <l,t,r,b>: 그 모니터 작업표시줄에서 위젯이 쓸 수 있는 오른쪽 끝(알림 영역 왼쪽)의 화면 x(물리 픽셀).
            // 도킹 미리보기가 실제로 붙을 자리(dock·slide의 GetRightAnchor)와 같아지도록 쓴다.
            if (action == "usableright" && args.Length >= 2)
            {
                string[] parts = args[1].Split(',');
                if (parts.Length != 4) return 2;
                RECT r = new RECT();
                r.Left = int.Parse(parts[0]); r.Top = int.Parse(parts[1]); r.Right = int.Parse(parts[2]); r.Bottom = int.Parse(parts[3]);
                IntPtr tb = FindTargetTaskbar(r);
                RECT pc;
                if (tb == IntPtr.Zero || !GetClientRect(tb, out pc)) return 1;
                POINT pt = new POINT();
                pt.X = GetRightAnchor(tb, pc.Right - pc.Left);
                pt.Y = 0;
                if (!ClientToScreen(tb, ref pt)) return 1;
                Emit(pt.X.ToString());
                return 0;
            }

            // slide <hwnd> <logicalOffset>: 도킹된 위젯을 작업표시줄 안에서 가로로만 옮긴다(왼쪽 기준).
            // dock처럼 스타일·부모를 다시 정하지 않으므로 끌기 중 매 좌표마다 불러도 watch가 도킹 유실로 오해하지 않는다.
            if (action == "slide" && args.Length >= 3)
            {
                IntPtr hwnd = ParseHwnd(args[1]);
                IntPtr parent = GetParent(hwnd);
                if (!IsWindow(hwnd) || parent == IntPtr.Zero) return 4;
                RECT pc, wr;
                if (!GetClientRect(parent, out pc) || !GetWindowRect(hwnd, out wr)) return 1;
                double scale = GetWindowDpi(parent) / 96.0;
                int width = wr.Right - wr.Left;
                int x = (int)Math.Round(double.Parse(args[2], System.Globalization.CultureInfo.InvariantCulture) * scale);
                // dock과 같이 알림 영역(트레이·시계) 왼쪽까지만 움직인다.
                x = Math.Max(0, Math.Min(x, GetRightAnchor(parent, pc.Right - pc.Left) - width));
                return SetWindowPos(hwnd, IntPtr.Zero, x, 0, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE) ? 0 : 1;
            }

            // fade <hwnd> <0-255|off>: 창 전체 투명도. Electron setOpacity는 한 번 layered가 된 창을 되돌리지 않아
            // 아크릴이 사라지므로, 다 보이게 할 때는 layered 속성 자체를 뗀다(DWM cloak은 다른 프로세스 창에 쓸 수 없다).
            if (action == "fade" && args.Length >= 3)
            {
                IntPtr hwnd = ParseHwnd(args[1]);
                if (!IsWindow(hwnd)) return 4;
                int ex = GetWindowLong(hwnd, GWL_EXSTYLE);
                if (args[2] == "off")
                {
                    SetWindowLong(hwnd, GWL_EXSTYLE, ex & ~WS_EX_LAYERED);
                    return 0;
                }
                SetWindowLong(hwnd, GWL_EXSTYLE, ex | WS_EX_LAYERED);
                return SetLayeredWindowAttributes(hwnd, 0, (byte)Math.Max(0, Math.Min(255, int.Parse(args[2]))), LWA_ALPHA) ? 0 : 1;
            }

            if (action == "inspect" && args.Length >= 2)
            {
                IntPtr hwnd = ParseHwnd(args[1]);
                RECT r;
                if (!GetWindowRect(hwnd, out r)) return 1;
                int width = r.Right-r.Left, height=r.Bottom-r.Top;
                IntPtr region=CreateRectRgn(0,0,0,0);
                try
                {
                    int kind=GetWindowRgn(hwnd,region);
                    int backdrop;
                    if(DwmGetWindowAttribute(hwnd,38,out backdrop,4)!=0) backdrop=-1;
                    StringBuilder parentName=new StringBuilder(64);
                    GetClassName(GetParent(hwnd),parentName,parentName.Capacity);
                    RECT client;
                    GetClientRect(hwnd,out client);
                    RECT clip;
                    GetRgnBox(region,out clip);
                    Emit(string.Format("WINDOW screen:{0},{1},{2},{3} region:{4} corner:{5} center:{6} backdrop:{7} parent:{8} client:{9},{10} style:{11:X} clip:{12},{13}",
                        r.Left,r.Top,width,height,kind,kind==0 || PtInRegion(region,0,0),kind==0 || PtInRegion(region,width/2,height/2),backdrop,parentName,client.Right,client.Bottom,GetWindowLong(hwnd,GWL_STYLE),clip.Right-clip.Left,clip.Bottom-clip.Top));
                    return 0;
                }
                finally { DeleteObject(region); }
            }

            // ==========================================
            // 1. DOCK: 실제 작업표시줄에 child HWND로 도킹
            // 인자: dock <childHwnd> <width> <height> <align: right|left> <offset> <vOffset> [monLeft,monTop,monRight,monBottom]
            // ==========================================
            if (action == "dock" && args.Length >= 7)
            {
                IntPtr childHwnd = ParseHwnd(args[1]);
                if (!IsWindow(childHwnd))
                {
                    Emit("INVALID_CHILD_HWND");
                    return 4;
                }

                double logicalWidth = double.Parse(args[2]);
                double logicalHeight = double.Parse(args[3]);
                string align = args[4].ToLower();
                double logicalOffset = double.Parse(args[5]);
                double logicalVOffset = double.Parse(args[6]);

                RECT? targetMonitorRect = null;
                if (args.Length >= 8 && !string.IsNullOrEmpty(args[7]))
                {
                    string[] parts = args[7].Split(',');
                    if (parts.Length == 4)
                    {
                        RECT r = new RECT();
                        r.Left = int.Parse(parts[0]);
                        r.Top = int.Parse(parts[1]);
                        r.Right = int.Parse(parts[2]);
                        r.Bottom = int.Parse(parts[3]);
                        targetMonitorRect = r;
                    }
                }

                IntPtr taskbarHwnd = FindTargetTaskbar(targetMonitorRect);
                if (taskbarHwnd == IntPtr.Zero || !IsWindow(taskbarHwnd))
                {
                    Emit("TASKBAR_NOT_FOUND");
                    return 2;
                }

                // 도킹 전 Electron HWND의 실제 physical rect 획득 (DPI 재계산 왜곡 방지)
                RECT origRect;
                GetWindowRect(childHwnd, out origRect);
                int existingNativeWidth = origRect.Right - origRect.Left;

                // GetClientRect로 실제 Taskbar Client 크기 조회
                RECT tbClientRect;
                if (!GetClientRect(taskbarHwnd, out tbClientRect))
                {
                    Emit("TASKBAR_CLIENT_RECT_FAILED");
                    return 3;
                }

                int taskbarClientWidth = tbClientRect.Right - tbClientRect.Left;
                int taskbarClientHeight = tbClientRect.Bottom - tbClientRect.Top;
                int contentPadding = args.Length >= 9 ? Math.Max(0,Math.Min(128,int.Parse(args[8]))) : 0;

                // 작업표시줄 DPI 스케일 감지
                int dpi = GetWindowDpi(taskbarHwnd);
                double scale = dpi / 96.0;

                // Windows top-level 최소 높이와 무관하게 작업표시줄의 실제 세로 영역을 채운다.
                int widgetWidthPx = (int)Math.Round(logicalWidth * scale);
                int widgetHeightPx = taskbarClientHeight + contentPadding;

                int physOffset = (int)Math.Round(logicalOffset * scale);
                int widgetY = 0;

                int widgetX = 0;
                if (align == "left")
                {
                    // taskbar client x=0 = 해당 모니터 작업표시줄의 왼쪽 끝 (Start 버튼 위치와 무관)
                    widgetX = physOffset;
                }
                else // right 정렬
                {
                    int rightAnchor = GetRightAnchor(taskbarHwnd, taskbarClientWidth);
                    widgetX = rightAnchor - physOffset - widgetWidthPx;
                }

                // 작업표시줄 내부 영역 클램핑. 오른쪽은 알림 영역(트레이·시계) 왼쪽까지만 써서 그 아이콘을 덮지 않는다.
                int usableRight = GetRightAnchor(taskbarHwnd, taskbarClientWidth);
                if (widgetX + widgetWidthPx > usableRight) widgetX = usableRight - widgetWidthPx;
                if (widgetX < 0) widgetX = 0;
                if (widgetX + widgetWidthPx > taskbarClientWidth) widgetX = taskbarClientWidth - widgetWidthPx;

                // 1) Window Style 변환: WS_POPUP 제거, WS_CHILD 추가
                int style = GetWindowLong(childHwnd, GWL_STYLE);
                if ((style & WS_CHILD) == 0) SetProp(childHwnd,"AIUsageWidget.OriginalStyle",new IntPtr(style));
                // WS_CAPTION/THICKFRAME/시스템 메뉴가 남으면 child client 높이에서 32px가 빠진다.
                style = (style & ~WS_POPUP & ~0x00CF0000) | WS_CHILD;
                SetWindowLong(childHwnd, GWL_STYLE, style);

                // 2) Extended Style: ToolWindow 설정, WS_EX_NOACTIVATE 제거 (포커스/마우스 인터랙션 차단 방지)
                int exStyle = GetWindowLong(childHwnd, GWL_EXSTYLE);
                exStyle |= WS_EX_TOOLWINDOW;
                exStyle &= ~WS_EX_APPWINDOW;
                exStyle &= ~WS_EX_NOACTIVATE;
                SetWindowLong(childHwnd, GWL_EXSTYLE, exStyle);

                // 3) SetParent 호출
                SetParent(childHwnd, taskbarHwnd);

                // 4) SetParent 검증 (GetParent 또는 GetAncestor로 실제 부모 확인)
                IntPtr currentParent = GetParent(childHwnd);
                if (currentParent != taskbarHwnd)
                {
                    currentParent = GetAncestor(childHwnd, GA_PARENT);
                }

                bool isParented = (currentParent == taskbarHwnd);
                int finalX = widgetX;
                int finalY = widgetY;
                IntPtr insertAfter = HWND_TOP;

                if (!isParented)
                {
                    // SetParent 거부 시 (Windows 11 최신 보안 등): WS_POPUP 유지, Screen 좌표계로 오버레이 배치
                    style = (style & ~WS_CHILD) | WS_POPUP;
                    SetWindowLong(childHwnd, GWL_STYLE, style);
                    exStyle = (exStyle | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW;
                    SetWindowLong(childHwnd, GWL_EXSTYLE, exStyle);

                    POINT pt = new POINT();
                    pt.X = widgetX;
                    pt.Y = widgetY;
                    ClientToScreen(taskbarHwnd, ref pt);
                    finalX = pt.X;
                    finalY = pt.Y;
                    insertAfter = HWND_TOPMOST;
                    currentParent = IntPtr.Zero;
                }

                // 5) 위치 및 크기 설정
                bool posOk = SetWindowPos(childHwnd, insertAfter, finalX, finalY, widgetWidthPx, widgetHeightPx,
                    SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
                // Chromium이 별도로 차감하는 프레임 공간은 보상하되 실제 그리기·클릭 영역은 작업표시줄에 맞춘다.
                IntPtr visibleRegion=CreateRectRgn(0,0,widgetWidthPx,taskbarClientHeight);
                if(SetWindowRgn(childHwnd,visibleRegion,true)==0) DeleteObject(visibleRegion);

                if (!posOk)
                {
                    int err = Marshal.GetLastWin32Error();
                    Emit(string.Format("POSITION_FAILED:{0}", err));
                    return 6;
                }

                RECT afterRect;
                GetWindowRect(childHwnd, out afterRect);

                StringBuilder parentClassBuf = new StringBuilder(64);
                GetClassName(currentParent, parentClassBuf, parentClassBuf.Capacity);
                string parentClassName = parentClassBuf.ToString();

                // 디버깅 로그 출력
                Emit(string.Format("Taskbar client = {0}x{1}", taskbarClientWidth, taskbarClientHeight));
                Emit(string.Format("taskbarDpi = {0}", dpi));
                Emit(string.Format("Electron HWND rect before docking = {0},{1} {2}x{3}",
                    origRect.Left, origRect.Top, origRect.Right - origRect.Left, origRect.Bottom - origRect.Top));
                Emit(string.Format("Electron HWND rect after docking = {0},{1} {2}x{3}",
                    afterRect.Left, afterRect.Top, afterRect.Right - afterRect.Left, afterRect.Bottom - afterRect.Top));
                Emit(string.Format("TaskbarHeight={0} WidgetHeight={1} FinalY={2} DPI={3}",
                    taskbarClientHeight, widgetHeightPx, widgetY, dpi));
                Emit(string.Format("Parent={0}", parentClassName));
                Emit(string.Format("DOCKED_OK taskbar:0x{0:X} widget:0x{1:X} client:{2},{3},{4},{5} screen:{6},{7},{8},{9} dpi:{10}",
                    taskbarHwnd.ToInt64(), childHwnd.ToInt64(), widgetX, widgetY, widgetWidthPx, widgetHeightPx,
                    afterRect.Left, afterRect.Top, afterRect.Right - afterRect.Left, afterRect.Bottom - afterRect.Top, dpi));

                return 0;
            }

            // ==========================================
            // 2. UNDOCK: 작업표시줄에서 분리하여 일반 top-level window로 복원
            // 인자: undock <childHwnd>
            // ==========================================
            else if (action == "undock" && args.Length >= 2)
            {
                IntPtr childHwnd = ParseHwnd(args[1]);
                if (!IsWindow(childHwnd))
                {
                    Emit("INVALID_CHILD_HWND");
                    return 4;
                }

                // 부모 분리
                SetWindowRgn(childHwnd,IntPtr.Zero,true);
                SetParent(childHwnd, IntPtr.Zero);

                // 스타일 복원: WS_CHILD 제거, WS_POPUP 복원
                int style = GetWindowLong(childHwnd, GWL_STYLE);
                IntPtr originalStyle = GetProp(childHwnd,"AIUsageWidget.OriginalStyle");
                style = originalStyle != IntPtr.Zero ? unchecked((int)originalStyle.ToInt64()) : (style & ~WS_CHILD) | WS_POPUP;
                RemoveProp(childHwnd,"AIUsageWidget.OriginalStyle");
                SetWindowLong(childHwnd, GWL_STYLE, style);

                int exStyle = GetWindowLong(childHwnd, GWL_EXSTYLE);
                exStyle &= ~WS_EX_TOOLWINDOW;
                exStyle &= ~WS_EX_NOACTIVATE;
                SetWindowLong(childHwnd, GWL_EXSTYLE, exStyle);

                SetWindowPos(childHwnd, IntPtr.Zero, 0, 0, 0, 0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW);

                Emit("UNDOCKED_OK");
                return 0;
            }

            // ==========================================
            // 4. GETSCREENRECT: 팝업 앵커용 위젯 실제 화면 절대 좌표 조회
            // 인자: getscreenrect <hwnd>
            // ==========================================
            else if (action == "getscreenrect" && args.Length >= 2)
            {
                IntPtr hwnd = ParseHwnd(args[1]);
                if (!IsWindow(hwnd))
                {
                    Emit("INVALID_HWND");
                    return 1;
                }

                RECT r;
                if (!GetWindowRect(hwnd, out r))
                {
                    Emit("GET_RECT_FAILED");
                    return 2;
                }

                Emit(string.Format("{0},{1},{2},{3}", r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top));
                return 0;
            }

            // ==========================================
            // 5. STAYTOP: (플로팅 모드 전용)
            // ==========================================
            else if (action == "staytop" && args.Length >= 2)
            {
                IntPtr childHwnd = ParseHwnd(args[1]);
                if (!IsWindow(childHwnd))
                {
                    Emit("INVALID_CHILD_HWND");
                    return 4;
                }

                int interval = 600;
                if (args.Length >= 3) int.TryParse(args[2], out interval);
                if (interval < 50) interval = 50;

                SetWindowPos(childHwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                Emit("STAYTOP_STARTED");

                while (IsWindow(childHwnd))
                {
                    SetWindowPos(childHwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                    Thread.Sleep(interval);
                }

                return 0;
            }

            // ==========================================
            // 6. FSWATCH: (플로팅 모드 전용 전체화면 감지)
            // ==========================================
            else if (action == "fswatch")
            {
                int interval = 1000;
                if (args.Length >= 2) int.TryParse(args[1], out interval);
                if (interval < 200) interval = 200;

                IntPtr widgetHwnd = args.Length >= 3 ? ParseHwnd(args[2]) : IntPtr.Zero;

                bool lastState = false;
                bool first = true;
                while (true)
                {
                    bool current = IsForegroundFullscreen(widgetHwnd);
                    if (first || current != lastState)
                    {
                        Emit(current ? "1" : "0");
                        EmitFlush();
                        lastState = current;
                        first = false;
                    }
                    Thread.Sleep(interval);
                }
            }

            // ==========================================
            // 7. WATCH: (도킹 모드 전용 상주 워처) 클릭 감지 + 도킹 유실 감지를 단일 프로세스에서 수행
            // 인자: watch <childHwnd> <expectedTaskbarHwnd>
            // 출력: CLICK (반복), DOCK_LOST (1회 출력 후 종료)
            // ==========================================
            else if (action == "pointerwatch")
            {
                // 창 바깥에서 버튼을 놓아도 제스처를 종료한다. 좌표는 물리 픽셀이며 Electron에서 DIP로 변환한다.
                // 기본 타이머 해상도(15.6ms)에서는 Sleep(16)이 약 31ms가 되어 이동이 끊기므로 1ms로 올리고 바뀐 좌표만 보낸다.
                timeBeginPeriod(1);
                int lastX = int.MinValue, lastY = int.MinValue;
                while (true)
                {
                    POINT p;
                    if (!GetCursorPos(out p)) return 1;
                    bool down = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0;
                    if (!down || p.X != lastX || p.Y != lastY)
                    {
                        Emit(string.Format("{0}:{1},{2}", down ? "MOVE" : "END", p.X, p.Y));
                        EmitFlush();
                        lastX = p.X; lastY = p.Y;
                    }
                    if (!down) return 0;
                    Thread.Sleep(4);
                }
            }
            else if (action == "watch" && args.Length >= 3)
            {
                IntPtr widget = ParseHwnd(args[1]);
                IntPtr taskbar = ParseHwnd(args[2]);
                timeBeginPeriod(1);
                bool previousDown = false;
                bool pressedOnWidget = false;
                bool dragging = false;
                POINT pressPoint = new POINT();

                while (IsWindow(widget))
                {
                    if (!IsWindow(taskbar) || GetParent(widget) != taskbar)
                    {
                        Emit("DOCK_LOST");
                        EmitFlush();
                        return 0;
                    }

                    bool down = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0;

                    // 누른 순간과 뗀 순간 모두 위젯 위일 때만 클릭으로 인정
                    // (전체화면 창이 위젯을 덮고 있거나, 다른 곳에서 드래그해 온 경우 무시)
                    if (down != previousDown)
                    {
                        bool onWidget = IsCursorOnWidget(widget, taskbar);
                        if (down) { pressedOnWidget = onWidget; dragging = false; GetCursorPos(out pressPoint); }
                        else if (pressedOnWidget && onWidget && !dragging)
                        {
                            Emit("CLICK");
                            EmitFlush();
                        }
                    }

                    POINT cursor;
                    if (down && pressedOnWidget && !dragging && GetCursorPos(out cursor)
                        && (Math.Abs(cursor.X - pressPoint.X) > 6 || Math.Abs(cursor.Y - pressPoint.Y) > 6))
                    {
                        dragging = true;
                        Emit("DRAG_START");
                        EmitFlush();
                    }

                    previousDown = down;
                    Thread.Sleep(16);
                }

                return 0;
            }

            return 3;
        }

        static int Main(string[] args)
        {
            int exitCode = 0;
            OptOutOfPowerThrottling();
            try
            {
                try
                {
                    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
                }
                catch { }

                try
                {
                    IntPtr hWinSta = OpenWindowStation("WinSta0", false, 0x000F037F);
                    if (hWinSta != IntPtr.Zero)
                    {
                        SetProcessWindowStation(hWinSta);
                    }
                }
                catch { }

                IntPtr hDesk = OpenDesktop("Default", 0, false, 0x000F01FF);
                if (hDesk == IntPtr.Zero)
                {
                    hDesk = OpenDesktop("default", 0, false, 0x000F01FF);
                }

                desktopHandle = hDesk;
                if (args.Length >= 1 && args[0] == "serve")
                {
                    if (hDesk != IntPtr.Zero) SetThreadDesktop(hDesk);
                    try { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); } catch { }
                    exitCode = Serve();
                }
                else if (hDesk != IntPtr.Zero)
                {
                    Thread t = new Thread(delegate ()
                    {
                        SetThreadDesktop(hDesk);
                        exitCode = RunAction(args);
                    });
                    t.Start();
                    t.Join();
                }
                else
                {
                    exitCode = RunAction(args);
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("ERROR: " + ex.Message);
                return 99;
            }

            return exitCode;
        }
    }
}

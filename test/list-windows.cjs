// Enumerate visible top-level windows of given process names with geometry.
const { execFileSync } = require('node:child_process');

const names = process.argv.slice(2);
const ps = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class E {
  public delegate bool Proc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Proc p, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L,T,R,B; }
  public static List<string> List(string[] names) {
    var want = new HashSet<string>(names, StringComparer.OrdinalIgnoreCase);
    var rows = new List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      string pname;
      try { pname = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { return true; }
      if (!want.Contains(pname)) return true;
      if (!IsWindowVisible(h)) return true;
      var t = new StringBuilder(512); GetWindowText(h, t, 512);
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      RECT r; GetWindowRect(h, out r);
      rows.Add(string.Format("{0}|{1}|{2}|{3}|{4}x{5}|{6}", pid, h.ToInt64(), c, t, r.R-r.L, r.B-r.T, r.L+","+r.T));
      return true;
    }, IntPtr.Zero);
    return rows;
  }
}
'@
[E]::List($env:CAP_NAMES.Split(',')) | ForEach-Object { Write-Output $_ }
`;
const stdout = execFileSync('powershell', ['-NoProfile', '-Command', ps], {
  env: { ...process.env, CAP_NAMES: names.join(',') },
  encoding: 'utf8',
});
console.log(stdout.trim());

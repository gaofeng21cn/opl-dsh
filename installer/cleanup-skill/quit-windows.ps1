param([int]$HostPid,[string]$Executable)
$ErrorActionPreference='Stop'
$backend=Get-CimInstance Win32_Process -Filter "ProcessId=$HostPid"
$desktop=Get-CimInstance Win32_Process -Filter "ProcessId=$($backend.ParentProcessId)"
if ($desktop.ExecutablePath -ne $Executable -or $backend.ExecutablePath -ne $Executable -or $desktop.CommandLine -match '--type=|setup\.mjs' -or $backend.CommandLine -notmatch 'desktop-host') { throw 'Desktop identity mismatch' }
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class DshQuit {
 [StructLayout(LayoutKind.Sequential)] struct Identity { public int pid; public System.Runtime.InteropServices.ComTypes.FILETIME time; }
 [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint handle,int flags,string key);
 [DllImport("rstrtmgr.dll")] static extern int RmRegisterResources(uint handle,uint files,IntPtr names,uint count,Identity[] apps,uint services,IntPtr serviceNames);
 [DllImport("rstrtmgr.dll")] static extern int RmShutdown(uint handle,uint flags,IntPtr callback);
 [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
 public static void Run(int pid,long stamp) {
   uint h;
   int code=RmStartSession(out h,0,Guid.NewGuid().ToString("N")); if(code!=0)throw new Exception("Restart Manager "+code);
   try {
     Identity app=new Identity(); app.pid=pid;app.time.dwLowDateTime=(int)stamp;app.time.dwHighDateTime=(int)(stamp>>32);
     code=RmRegisterResources(h,0,IntPtr.Zero,1,new Identity[]{app},0,IntPtr.Zero);
     if(code==0)code=RmShutdown(h,0,IntPtr.Zero);
     if(code!=0)throw new Exception("Desktop shutdown "+code);
   } finally {RmEndSession(h);}
 }
}
'@
$p=Get-Process -Id $desktop.ProcessId
if($p.Path -ne $Executable -or [Math]::Abs(($p.StartTime-$desktop.CreationDate).TotalMilliseconds) -gt 2){throw 'Desktop changed'}
[DshQuit]::Run($p.Id,$p.StartTime.ToFileTimeUtc())

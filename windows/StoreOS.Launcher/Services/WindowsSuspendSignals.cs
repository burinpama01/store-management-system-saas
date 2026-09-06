using Microsoft.Win32;

using StoreOS.Voice;

namespace StoreOS.Launcher.Services;

/// <summary>
/// ต่อสัญญาณล็อกจอ/หลับ/ตื่นของ Windows เข้ากับตัวประสานงานไมโครโฟน (แผน v1 W3)
///
/// ทำไมต้องสน: ถ้าไม่ปล่อยไมค์ตอนล็อกจอ จะเกิดสองเรื่องพร้อมกัน —
///   1. ไฟไมค์ติดค้างบนเครื่องที่ไม่มีคนอยู่ ซึ่งพนักงานตีความว่าโปรแกรมแอบฟัง
///   2. Windows อาจยึดอุปกรณ์คืนตอนตื่น แล้ว engine ค้างอยู่ในสถานะที่กู้เองไม่ได้
///
/// SystemEvents ยิงบนเธรดของระบบ ไม่ใช่เธรด UI — ตัวรับปลายทางจึงต้องปลอดภัยต่อการเรียกข้ามเธรด
/// (MicrophoneCoordinator ใช้ semaphore คุมอยู่แล้ว)
/// </summary>
public sealed class WindowsSuspendSignals : ISystemSuspendSignals, IDisposable
{
    public event EventHandler? Suspending;
    public event EventHandler? Resumed;

    public WindowsSuspendSignals()
    {
        SystemEvents.SessionSwitch += OnSessionSwitch;
        SystemEvents.PowerModeChanged += OnPowerModeChanged;
    }

    private void OnSessionSwitch(object sender, SessionSwitchEventArgs e)
    {
        switch (e.Reason)
        {
            // ล็อกจอ หรือสลับผู้ใช้ = เครื่องนี้ไม่ควรถือไมค์ต่อ
            case SessionSwitchReason.SessionLock:
            case SessionSwitchReason.SessionLogoff:
            case SessionSwitchReason.ConsoleDisconnect:
                Suspending?.Invoke(this, EventArgs.Empty);
                break;
            case SessionSwitchReason.SessionUnlock:
            case SessionSwitchReason.SessionLogon:
            case SessionSwitchReason.ConsoleConnect:
                Resumed?.Invoke(this, EventArgs.Empty);
                break;
        }
    }

    private void OnPowerModeChanged(object sender, PowerModeChangedEventArgs e)
    {
        switch (e.Mode)
        {
            case PowerModes.Suspend:
                Suspending?.Invoke(this, EventArgs.Empty);
                break;
            case PowerModes.Resume:
                Resumed?.Invoke(this, EventArgs.Empty);
                break;
        }
    }

    public void Dispose()
    {
        SystemEvents.SessionSwitch -= OnSessionSwitch;
        SystemEvents.PowerModeChanged -= OnPowerModeChanged;
    }
}

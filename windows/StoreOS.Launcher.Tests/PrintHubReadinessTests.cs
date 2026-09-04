using StoreOS.Launcher.Services;
using Xunit;

namespace StoreOS.Launcher.Tests;

/// <summary>
/// v3 Task 8 — Launcher ตัดสินใจอย่างไรกับ Print Hub
/// กติกาที่ต้องคง: POS เปิดได้เสมอ, ไม่สั่ง start ซ้ำโดยไม่จำเป็น, ไม่ฆ่า Hub ที่อาจกำลังพิมพ์
/// </summary>
public class PrintHubReadinessTests
{
    private static readonly DateTimeOffset Now = new(2026, 9, 4, 8, 0, 0, TimeSpan.FromHours(7));

    private static HubHealthSnapshot Health(string state, TimeSpan age) => new()
    {
        SchemaVersion = 1,
        Pid = 4242,
        AgentVersion = "1.1.0",
        ProtocolVersion = 1,
        State = state,
        UpdatedAt = Now - age,
    };

    [Fact]
    public void Ready_health_means_ready_and_no_start_command()
    {
        var decision = PrintHubReadiness.Decide(Health("ready", TimeSpan.FromSeconds(3)), ScheduledTaskState.Running, Now);

        Assert.Equal(ReadinessState.Ready, decision.State);
        Assert.False(decision.ShouldStartTask);
    }

    [Fact]
    public void Stale_health_with_stopped_task_starts_the_task()
    {
        var decision = PrintHubReadiness.Decide(Health("ready", TimeSpan.FromMinutes(5)), ScheduledTaskState.Stopped, Now);

        Assert.Equal(ReadinessState.Preparing, decision.State);
        Assert.True(decision.ShouldStartTask);
    }

    [Fact]
    public void Stale_health_while_task_says_running_is_degraded_not_restarted()
    {
        // Hub อาจกำลังพิมพ์ค้างอยู่ — ฆ่าทิ้งเองเสี่ยงใบเสร็จหาย จึงแค่รายงาน degraded
        var decision = PrintHubReadiness.Decide(Health("ready", TimeSpan.FromMinutes(5)), ScheduledTaskState.Running, Now);

        Assert.Equal(ReadinessState.Degraded, decision.State);
        Assert.False(decision.ShouldStartTask);
    }

    [Fact]
    public void Fresh_but_not_ready_waits_instead_of_starting_again()
    {
        var decision = PrintHubReadiness.Decide(Health("starting", TimeSpan.FromSeconds(2)), ScheduledTaskState.Running, Now);

        Assert.Equal(ReadinessState.Preparing, decision.State);
        Assert.False(decision.ShouldStartTask);
    }

    [Fact]
    public void Outdated_agent_is_not_restarted_because_restarting_cannot_fix_it()
    {
        var decision = PrintHubReadiness.Decide(Health("outdated", TimeSpan.FromSeconds(2)), ScheduledTaskState.Running, Now);

        Assert.Equal(ReadinessState.Outdated, decision.State);
        Assert.False(decision.ShouldStartTask);
        Assert.Contains("ติดตั้ง", decision.Message);
    }

    [Fact]
    public void No_task_and_no_health_means_not_installed()
    {
        var decision = PrintHubReadiness.Decide(null, ScheduledTaskState.Missing, Now);

        Assert.Equal(ReadinessState.NotInstalled, decision.State);
        Assert.False(decision.ShouldStartTask);
    }

    [Fact]
    public void Corrupt_health_file_does_not_throw()
    {
        Assert.Null(PrintHubReadiness.Parse("{ half written"));
        Assert.Null(PrintHubReadiness.Parse(null));
        Assert.Null(PrintHubReadiness.Parse("   "));
    }

    [Fact]
    public void Health_file_lives_next_to_the_agent_state()
    {
        var path = PrintHubReadiness.HealthFilePath(@"C:\Users\x\AppData\Local");

        Assert.EndsWith(@"StoreOSPrintHub\health.json", path);
    }

    [Theory]
    [InlineData("Status:  Running", ScheduledTaskState.Running)]
    [InlineData("Status:  Ready", ScheduledTaskState.Stopped)]
    [InlineData("Status:  Disabled", ScheduledTaskState.Stopped)]
    [InlineData("", ScheduledTaskState.Unknown)]
    public void Scheduled_task_output_is_parsed(string stdout, ScheduledTaskState expected)
    {
        Assert.Equal(expected, ScheduledTaskController.ParseState(stdout));
    }

    [Fact]
    public void Launcher_never_launches_the_agent_directly()
    {
        // ถ้ามีวันหนึ่งมีคนเพิ่มการเรียก node/print-hub.mjs เข้ามา เทสต์นี้ต้องดัง:
        // เจ้าของ process ของ Hub มีทางเดียวคือ Scheduled Task (แผน v3 §2)
        var source = File.ReadAllText(Path.Combine(SolutionDir(), "StoreOS.Launcher", "MainWindow.xaml.cs"));

        Assert.DoesNotContain("print-hub.mjs", source);
        Assert.DoesNotContain("node.exe", source);
    }

    private static string SolutionDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && dir.Name != "windows") dir = dir.Parent;
        return dir?.FullName ?? throw new DirectoryNotFoundException("windows/ not found");
    }
}

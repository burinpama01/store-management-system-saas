using System.IO;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace StoreOS.Launcher.Services.Audio;

/// <summary>ผลของการเล่นหนึ่งครั้ง — FellBack = ลำโพงที่เลือกหายไป เลยเล่นออกลำโพงหลักแทน</summary>
public sealed record AlertPlayResult(bool Played, bool FellBack, string? DeviceName, string? Error);

/// <summary>
/// เล่นเสียงแจ้งเตือนของ POS จากตัว Launcher เอง (ไม่ผ่าน WebView2)
///
/// ทำไมต้องเล่นเอง: เพลงร้าน (/player) กับเสียงแจ้งเตือนอยู่ใน WebView2 ตัวเดียวกัน Windows จึงแยก
/// ลำโพงให้ไม่ได้ — ย้ายเสียงแจ้งเตือนออกมาเล่นด้วย WASAPI ตรงไปอุปกรณ์ที่เลือกจึงแยกได้จริง
/// ได้ของแถม: ไม่ติดกติกา autoplay ของเบราว์เซอร์ ดังได้ตั้งแต่เปิดเครื่องโดยไม่มีใครแตะจอ
/// </summary>
public sealed class AlertPlayer : IDisposable
{
    private const int ToneSampleRate = 44100;
    /// <summary>กันเสียงซ้อนกันจนเครื่องค้าง (หน้าเว็บวนเสียงทุก 3.5 วิ + toast ซ้อนได้)</summary>
    private const int MaxConcurrent = 4;

    private readonly IAudioDeviceCatalog _catalog;
    private readonly Func<LauncherSettings> _settings;
    private readonly Action<string, string, string> _log;
    private readonly object _gate = new();
    private readonly List<WasapiOut> _active = new();
    private (float[] Samples, WaveFormat Format)? _orderSound;
    private bool _disposed;

    public AlertPlayer(IAudioDeviceCatalog catalog, Func<LauncherSettings> settings, Action<string, string, string> log)
    {
        _catalog = catalog;
        _settings = settings;
        _log = log;
    }

    public AlertPlayResult Play(string sound)
    {
        if (!AlertSoundIds.IsKnown(sound)) return new AlertPlayResult(false, false, null, "unknown_sound");

        var settings = _settings();
        var (target, fellBack) = AudioDeviceResolver.Resolve(settings.AlertOutputDeviceId, SafeList());
        if (fellBack)
        {
            _log("warn", "alert_device_missing", "ลำโพงเสียงแจ้งเตือนที่เลือกไม่อยู่ — เล่นออกลำโพงหลักแทน");
        }

        try
        {
            var provider = BuildProvider(sound, settings.AlertVolume);
            if (provider is null) return new AlertPlayResult(false, fellBack, null, "no_sound_data");

            var device = WasapiDeviceCatalog.Open(target?.Id);
            if (device is null) return new AlertPlayResult(false, fellBack, null, "no_output_device");

            lock (_gate)
            {
                if (_disposed) return new AlertPlayResult(false, fellBack, null, "disposed");
                if (_active.Count >= MaxConcurrent) return new AlertPlayResult(false, fellBack, device.FriendlyName, "busy");
            }

            var output = new WasapiOut(device, AudioClientShareMode.Shared, useEventSync: true, latency: 80);
            output.PlaybackStopped += (_, _) =>
            {
                lock (_gate) _active.Remove(output);
                output.Dispose();
                device.Dispose();
            };
            output.Init(provider);
            lock (_gate) _active.Add(output);
            output.Play();
            return new AlertPlayResult(true, fellBack, target?.Name ?? device.FriendlyName, null);
        }
        catch (Exception ex)
        {
            _log("warn", "alert_play_failed", $"เล่นเสียงแจ้งเตือนไม่สำเร็จ: {ex.GetType().Name}");
            return new AlertPlayResult(false, fellBack, null, ex.GetType().Name);
        }
    }

    private IReadOnlyList<AudioOutputDevice> SafeList()
    {
        try
        {
            return _catalog.ListOutputs();
        }
        catch (Exception)
        {
            return [];
        }
    }

    private ISampleProvider? BuildProvider(string sound, int volume)
    {
        ISampleProvider? source;
        if (sound == AlertSoundIds.Order)
        {
            var decoded = _orderSound ??= DecodeOrderSound();
            source = new ArraySampleProvider(decoded.Samples, decoded.Format);
        }
        else
        {
            var samples = AlertTones.Render(sound, ToneSampleRate);
            source = samples.Length == 0
                ? null
                : new ArraySampleProvider(samples, WaveFormat.CreateIeeeFloatWaveFormat(ToneSampleRate, 1));
        }
        if (source is null) return null;
        return new VolumeSampleProvider(source) { Volume = Math.Clamp(volume, 0, 100) / 100f };
    }

    /// <summary>ถอดรหัส mp3 ที่ฝังใน assembly ครั้งเดียวแล้วเก็บไว้ (1.6 วิ ≈ 0.5 MB float)</summary>
    private static (float[] Samples, WaveFormat Format) DecodeOrderSound()
    {
        using var stream = typeof(AlertPlayer).Assembly.GetManifestResourceStream("StoreOS.Launcher.alert_new_order.mp3")
            ?? throw new InvalidOperationException("ไม่พบไฟล์เสียงออเดอร์ใน Launcher");
        using var reader = new StreamMediaFoundationReader(stream);
        var provider = reader.ToSampleProvider();
        var buffer = new List<float>(reader.WaveFormat.SampleRate * reader.WaveFormat.Channels * 2);
        var chunk = new float[provider.WaveFormat.SampleRate * provider.WaveFormat.Channels];
        int read;
        while ((read = provider.Read(chunk, 0, chunk.Length)) > 0)
        {
            for (var i = 0; i < read; i++) buffer.Add(chunk[i]);
        }
        return (buffer.ToArray(), provider.WaveFormat);
    }

    public void Dispose()
    {
        List<WasapiOut> toStop;
        lock (_gate)
        {
            _disposed = true;
            toStop = _active.ToList();
            _active.Clear();
        }
        foreach (var output in toStop)
        {
            try
            {
                output.Stop();
                output.Dispose();
            }
            catch (Exception)
            {
                // ปิดโปรแกรมอยู่ — ไม่มีอะไรต้องทำต่อ
            }
        }
    }

    /// <summary>ป้อน sample จากอาร์เรย์ที่ถอดรหัสไว้แล้ว (เล่นซ้ำได้ไม่ต้องถอดรหัสใหม่)</summary>
    private sealed class ArraySampleProvider(float[] samples, WaveFormat format) : ISampleProvider
    {
        private int _position;
        public WaveFormat WaveFormat { get; } = format;

        public int Read(float[] buffer, int offset, int count)
        {
            var available = Math.Min(count, samples.Length - _position);
            if (available <= 0) return 0;
            Array.Copy(samples, _position, buffer, offset, available);
            _position += available;
            return available;
        }
    }
}

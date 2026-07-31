namespace UnifiedPlayerControlPoc;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Contains(
                "--self-test-qq-audio-capture",
                StringComparer.OrdinalIgnoreCase))
        {
            using var audioCapture = QQMusicAudioMuteScope.Capture();
            if (!string.IsNullOrWhiteSpace(audioCapture.CaptureError))
            {
                return 2;
            }

            return audioCapture.CapturedSessionCount > 0 ? 0 : 3;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
        return 0;
    }
}

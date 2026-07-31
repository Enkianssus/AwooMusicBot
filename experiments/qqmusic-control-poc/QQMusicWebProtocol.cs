namespace QQMusicControlPoc;

internal static class QQMusicWebProtocol
{
    private const string RootElement =
        "command-lable-xwl78-qq-music";

    public static string QueryPlayStatus()
    {
        return BuildQuery("QueryPlayStatus");
    }

    public static string QueryListInfo()
    {
        return BuildQuery("QueryListInfo");
    }

    private static string BuildQuery(string subcommand)
    {
        return "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
            + $"<{RootElement}>"
            + "<cmd value=\"1074\">"
            + $"<subcmd value=\"{subcommand}\"/>"
            + "</cmd>"
            + $"</{RootElement}>";
    }
}

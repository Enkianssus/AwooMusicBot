namespace QQMusicControlPoc;

internal sealed record QQMusicNativeNextProfile(
    string FileVersion,
    string ClientSha256,
    string CommonSha256,
    int SingleSongPlayDispatchRva,
    byte[] ExpectedPlayDispatchBytes,
    int GetCatManagerRva,
    int GetQqUinExRva,
    int SongItemConstructorRva,
    int SongItemDestructorRva,
    int AddSongsRva,
    int HiddenCategoryIdRva,
    int GetListRootRva,
    int GetListHelperRva,
    int GetCategoryCountRva,
    int SongItemSize,
    string Evidence);

internal static class QQMusicNativeNextProfiles
{
    private static readonly QQMusicNativeNextProfile[] KnownProfiles =
    [
        new(
            "22.22",
            "FF0AB7911EB2ACF433F2DAF0FC4BA48FFFC64169CD822CE4D5B00E88FA180A50",
            "9F7FC7DF5BC4BBE9B4C3377449CBCB3C47A218A934FAAE4DFF8578C3EDAF652F",
            0x0047A4F4,
            [0xE8, 0xD7, 0x53, 0x16, 0x00],
            0x0000F0ED,
            0x0002E089,
            0x0004A2A0,
            0x00049DE0,
            0x0042C010,
            0x00C141A0,
            0x00602430,
            0x00602590,
            0x004DBBC0,
            0xA0,
            "2026-07-30 现场捕捉右键下一首播放并重复验证"),
        new(
            "22.41",
            "A5F3E917A5233D925268C34656E49096B6223B74631C5002DB606AD4B2C7A3F3",
            "36775378403DB33D049EE87BCAD654BA3A041B7D41259CD7EDFE65457D7E2A06",
            0x0048C090,
            [0xE8, 0x2B, 0x30, 0x16, 0x00],
            0x0000F0ED,
            0x0002E089,
            0x0004B800,
            0x0004B340,
            0x0043DA80,
            0x00C301A0,
            0x006142F0,
            0x00614450,
            0x004ED5D0,
            0xA0,
            "2026-07-31 从 playsong/addsong、右键菜单、导出表和调用图静态恢复")
    ];

    public static IReadOnlyList<QQMusicNativeNextProfile> All =>
        KnownProfiles;

    public static QQMusicNativeNextProfile? Find(
        string fileVersion,
        string clientSha256,
        string commonSha256)
    {
        return KnownProfiles.FirstOrDefault(profile =>
            string.Equals(
                profile.FileVersion,
                fileVersion,
                StringComparison.Ordinal)
            && string.Equals(
                profile.ClientSha256,
                clientSha256,
                StringComparison.OrdinalIgnoreCase)
            && (string.IsNullOrWhiteSpace(profile.CommonSha256)
                || string.Equals(
                    profile.CommonSha256,
                    commonSha256,
                    StringComparison.OrdinalIgnoreCase)));
    }
}

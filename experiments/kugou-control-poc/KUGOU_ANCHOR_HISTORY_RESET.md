# KuGou no-track-switch insertion-anchor reset

Validated on 2026-08-02 against:

- KuGou `20.0.81.27563`
- `kugou.dll` SHA-256
  `193CEB92AC2281FCDC8A109BC533F3BC54FCCAFDA0CB1C0E61C0D140657F6132`

## Finding

The persistent WM_COPYDATA insertion anchor is derived from a tracker reached
through `QueueController+0x60`. Its `+0x10/+0x14/+0x18` fields are the
begin/end/capacity pointers of a four-byte history vector. Each insertion adds
the inserted `SongItem` to this history.

The real Previous flow clears this history. In the controlled differential:

- before navigation: history count `8`;
- after Next: history count `7`, last inserted item still present;
- after Previous: history count `0`, with `end == begin`.

The exact native member that performs the reset is:

- RVA `0x00905251`;
- effect: set the history end to begin, then publish the class's normal
  internal notifications.

`KugouAnchorHistoryResetProbe.Reset()` resolves the tracker dynamically and
invokes this member without sending Previous or changing playback. It rejects
execution unless the DLL version/hash, controller vtable, all three tracker
vtables, function RVA, and function bytes match the validated build. Its
temporary executable allocation is released in `finally`.

## Clean validation

Round 1:

- C: `Sad Machine` (paused)
- A: `Goodbye To A World`
- reset: history `1 -> 0`; title, SongItem and position unchanged
- B: `Something Comforting`
- visible result: `Sad Machine -> Something Comforting -> Goodbye To A World`

Round 2, after clearing the queue:

- C: `Unity` (paused)
- A: `Windfall`
- reset: history `1 -> 0`; title, SongItem and position unchanged
- B: `Never Be Alone`
- visible result: `Unity -> Never Be Alone -> Windfall`

Both rounds kept the current track, paused state, and displayed volume/mute
state unchanged. The production connector has not been modified.

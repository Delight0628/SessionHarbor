from pathlib import Path

p = Path(r"D:\MiMo_Desktop\Xiaomi MiMo\resources\app.asar")
data = p.read_bytes()


def dump(offset, radius=2200):
    frag = data[max(0, offset - 350) : offset + radius]
    s = "".join(chr(b) if 32 <= b < 127 else "\n" for b in frag)
    print("\n".join(x for x in s.splitlines() if x.strip()))


# engine fork route handler - search messageID near fork
for needle in [b"messageID", b"messageId"]:
    start = 0
    c = 0
    while c < 15:
        i = data.find(needle, start)
        if i < 0:
            break
        window = data[max(0, i - 200) : i + 200]
        if b"fork" in window.lower() or b"Fork" in window:
            print(f"\n##### {needle} @{i} near fork #####")
            dump(i, 1500)
        start = i + len(needle)
        c += 1

print("\n\n===== route post session fork =====")
for needle in [
    b'"/session/:id/fork"',
    b"/session/:sid/fork",
    b"session/:id/fork",
    b"session/:sessionId/fork",
    b"`/session/${",
]:
    i = data.find(needle)
    print(needle, i)
    if i > 0:
        dump(i, 1800)

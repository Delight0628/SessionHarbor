from pathlib import Path

p = Path(r"D:\MiMo_Desktop\Xiaomi MiMo\resources\app.asar")
data = p.read_bytes()


def dump(offset, radius=2800):
    frag = data[max(0, offset - 400) : offset + radius]
    s = "".join(chr(b) if 32 <= b < 127 else "\n" for b in frag)
    print("\n".join(x for x in s.splitlines() if x.strip()))


for needle in [b"importedSessionIds", b"importedSession", b"claude_import", b"external_import"]:
    start = 0
    c = 0
    while c < 8:
        i = data.find(needle, start)
        if i < 0:
            break
        print(f"\n\n########## {needle} @{i} ##########")
        dump(i, 2000)
        start = i + len(needle)
        c += 1

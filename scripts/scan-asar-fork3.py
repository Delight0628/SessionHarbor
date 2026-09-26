from pathlib import Path

p = Path(r"D:\MiMo_Desktop\Xiaomi MiMo\resources\app.asar")
data = p.read_bytes()


def dump(offset, radius=3500):
    frag = data[max(0, offset - 400) : offset + radius]
    s = "".join(chr(b) if 32 <= b < 127 else "\n" for b in frag)
    lines = [x for x in s.splitlines() if x.strip()]
    print("\n".join(lines))


for needle in [b"forkArtifacts", b"boundaryMessageId", b"cloneMessages", b"copyMessages"]:
    start = 0
    c = 0
    while c < 6:
        i = data.find(needle, start)
        if i < 0:
            break
        print(f"\n\n########## {needle!r} @{i} ##########")
        dump(i, 2800)
        start = i + len(needle)
        c += 1

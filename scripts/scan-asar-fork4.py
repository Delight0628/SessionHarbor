from pathlib import Path

p = Path(r"D:\MiMo_Desktop\Xiaomi MiMo\resources\app.asar")
data = p.read_bytes()


def dump(offset, radius=2000):
    frag = data[max(0, offset - 300) : offset + radius]
    s = "".join(chr(b) if 32 <= b < 127 else "\n" for b in frag)
    print("\n".join(x for x in s.splitlines() if x.strip()))


# a0e is body builder for fork; find function a0e definition nearby 9668188
# search `/fork` path
for needle in [b"/fork", b"session/fork", b'"fork"', b"kind:\"fork\"", b"createFork", b"fork("]:
    start = 0
    c = 0
    while c < 4:
        i = data.find(needle, start)
        if i < 0:
            break
        if 9_500_000 < i < 11_200_000 or 48_000_000 < i < 52_000_000:
            print(f"\n##### {needle!r} @{i} #####")
            dump(i, 1200)
        start = i + len(needle)
        c += 1

print("\n\n===== around 9667800 (fork POST) =====")
dump(9667800, 1500)

from pathlib import Path

p = Path(r"D:\MiMo_Desktop\Xiaomi MiMo\resources\app.asar")
data = p.read_bytes()


def dump(offset, radius=2500):
    frag = data[max(0, offset - 400) : offset + radius]
    s = "".join(chr(b) if 32 <= b < 127 else "\n" for b in frag)
    print("\n".join(x for x in s.splitlines() if x.strip()))


for needle in [
    b"function a0e",
    b"a0e=",
    b"/session/",
    b"session/:",
    b"post(\"/session",
    b"post(`/session",
    b"forkFrom",
    b"cloneToSession",
    b"copySessionMessages",
]:
    start = 0
    c = 0
    while c < 5:
        i = data.find(needle, start)
        if i < 0:
            break
        # only interesting regions
        if i < 20_000_000 or i > 40_000_000:
            ctx = data[i : i + 80]
            print(f"{needle!r} @{i} ... {ctx[:60]!r}")
        start = i + len(needle)
        c += 1

print("\n===== search message clone on fork =====")
for needle in [b"boundary", b"forkSession", b"createChildSession", b"sessionCopy"]:
    start = 0
    c = 0
    while c < 3:
        i = data.find(needle, start)
        if i < 0:
            break
        print(f"\n## {needle} @{i}")
        dump(i, 800)
        start = i + len(needle)
        c += 1

from pathlib import Path

p = Path(r"D:\MiMo_Desktop\Xiaomi MiMo\resources\app.asar")
data = p.read_bytes()


def dump(offset, radius=2500):
    frag = data[max(0, offset - 300) : offset + radius]
    s = "".join(chr(b) if 32 <= b < 127 else "\n" for b in frag)
    print("\n".join(x for x in s.splitlines() if x.strip()))


# ome splits imported sessions
i = data.find(b"function ome")
print("===== ome =====", i)
if i > 0:
    dump(i, 1800)

# fork disable for imported?
for needle in [b"canFork", b"forkDisabled", b"importedList", b"adoptedImports"]:
    start = 0
    c = 0
    while c < 3:
        j = data.find(needle, start)
        if j < 0:
            break
        print(f"\n## {needle} @{j}")
        dump(j, 900)
        start = j + len(needle)
        c += 1

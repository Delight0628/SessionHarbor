from pathlib import Path

p = Path(r"D:\MiMo_Desktop\Xiaomi MiMo\resources\app.asar")
data = p.read_bytes()


def contexts(needle: bytes, n=8, radius=180):
    start = 0
    found = 0
    while found < n:
        i = data.find(needle, start)
        if i < 0:
            break
        frag = data[max(0, i - radius) : i + radius]
        # keep printable
        s = "".join(chr(b) if 32 <= b < 127 else "\n" for b in frag)
        s = "\n".join(x for x in s.splitlines() if x.strip())
        print(f"\n===== {needle!r} @{i} =====")
        print(s[:500])
        start = i + len(needle)
        found += 1


print("PARENTID")
contexts(b"parentID", n=6)
print("\n\nFORK SESSION / createFork")
contexts(b"createFork", n=5)
contexts(b"forkSession", n=5)
contexts(b"session_fork", n=3)
contexts(b"(fork #", n=4)

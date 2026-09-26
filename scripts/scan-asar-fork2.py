from pathlib import Path

p = Path(r"D:\MiMo_Desktop\Xiaomi MiMo\resources\app.asar")
data = p.read_bytes()


def dump(offset, radius=2500):
    frag = data[offset - 200 : offset + radius]
    s = "".join(chr(b) if 32 <= b < 127 else "\n" for b in frag)
    lines = [x for x in s.splitlines() if x.strip()]
    print("\n".join(lines))


print("===== forkSession harness @9621947 =====")
dump(9621947, 800)
print("\n\n===== mimo:forkSession handler @11013745 =====")
dump(11013745, 3500)
print("\n\n===== getForkedTitle @48414643 =====")
dump(48414000, 2000)

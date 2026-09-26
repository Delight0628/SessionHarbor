from pathlib import Path

p = Path(r"D:\MiMo_Desktop\Xiaomi MiMo\resources\app.asar")
data = p.read_bytes()

# a0e full
i = data.find(b"function a0e")
print("===== a0e =====")
print("".join(chr(b) if 32 <= b < 127 else "\n" for b in data[i : i + 800]))

# startEngine / engine path
for needle in [b"startEngine", b"mimocode", b"engine-entry", b"ENGINE_PATH", b"bin/mimo", b"dist/server"]:
    start = 0
    c = 0
    while c < 4:
        j = data.find(needle, start)
        if j < 0:
            break
        ctx = "".join(chr(b) if 32 <= b < 127 else "\n" for b in data[j - 80 : j + 200])
        print(f"\n## {needle} @{j}\n{ctx[:280]}")
        start = j + len(needle)
        c += 1

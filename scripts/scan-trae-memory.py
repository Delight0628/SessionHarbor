"""Scan Trae memory and try keys in-process with @signalapp/sqlcipher."""
import ctypes
import ctypes.wintypes as wintypes
import re
import sys
from pathlib import Path

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
MEM_COMMIT = 0x1000
PAGE_READWRITE = 0x04
PAGE_EXECUTE_READ = 0x20
PAGE_EXECUTE_READWRITE = 0x40

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)


class MEMORY_BASIC_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", wintypes.DWORD),
        ("RegionSize", ctypes.c_size_t),
        ("State", wintypes.DWORD),
        ("Protect", wintypes.DWORD),
        ("Type", wintypes.DWORD),
    ]


def extract_keys(pid: int) -> set[str]:
    h = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not h:
        return set()
    keys = set()
    mbi = MEMORY_BASIC_INFORMATION()
    addr = 0
    while addr < 0x7FFFFFFFFFFF:
        n = kernel32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi))
        if not n:
            break
        if mbi.State == MEM_COMMIT and mbi.Protect in (PAGE_READWRITE, PAGE_EXECUTE_READ, PAGE_EXECUTE_READWRITE):
            size = mbi.RegionSize
            if 16 < size < 64 * 1024 * 1024:
                buf = (ctypes.c_char * size)()
                read = ctypes.c_size_t()
                if kernel32.ReadProcessMemory(h, ctypes.c_void_p(mbi.BaseAddress), buf, size, ctypes.byref(read)):
                    data = bytes(buf[: read.value])
                    for m in re.finditer(rb"[A-Za-z0-9]{32}", data):
                        s = m.group().decode("ascii")
                        if not (re.search(r"[0-9]", s) and re.search(r"[a-z]", s) and re.search(r"[A-Z]", s)):
                            continue
                        if any(x in s.lower() for x in ("http", "png", "jpg", "buffer", "undefined", "function", "object")):
                            continue
                        keys.add(s)
        addr = (mbi.BaseAddress or 0) + (mbi.RegionSize or 0x1000)
    kernel32.CloseHandle(h)
    return keys


if __name__ == "__main__":
    pids = [int(x) for x in sys.argv[1:]] or [44804, 22936, 22044, 4412, 10104, 14796]
    db = r"d:\user\tc032353\Application Data\Trae CN\ModularData\ai-agent\database.db"
    all_keys = set()
    for pid in pids:
        ks = extract_keys(pid)
        print(f"pid {pid}: {len(ks)} candidates")
        all_keys |= ks
    print(f"total unique: {len(all_keys)}")

    # load signalapp sqlcipher
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "sqlcipher",
        r"D:\SessionHarbor\vendor-sqlcipher\signalapp\package\dist\index.mjs",
    )
    # can't import mjs from python; write keys to file for node
    out = Path(r"D:\SessionHarbor\scripts\trae-keys.txt")
    out.write_text("\n".join(sorted(all_keys)), encoding="utf-8")
    print(f"keys written to {out} ({len(all_keys)})")

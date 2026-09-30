from pathlib import Path

p = Path(r"D:\SessionHarbor\apps\desktop\renderer\app.js")
text = p.read_text(encoding="utf-8")
start = text.find("    // 下拉框：只保留本机已检测到的客户端")
end = text.find("if ([...dst.options].some((o) => o.value === prevDst)) dst.value = prevDst")
if start < 0 or end < 0:
    print("not found", start, end)
    raise SystemExit(1)
end = end + len("if ([...dst.options].some((o) => o.value === prevDst)) dst.value = prevDst")
new = """    // 源下拉：本机已检测到的客户端全部可选（含只读如 Trae）
    const readInstalled = list.filter((c) => c.installed ?? c.ok);
    const writable = readInstalled.filter((c) => c.canWrite !== false);
    const src = $("#client");
    const dst = $("#migrateTo");
    const prevSrc = src.value;
    const prevDst = dst.value;
    src.innerHTML = readInstalled.length
      ? readInstalled
          .map((c) => `<option value="${c.id}">${escapeHtml(c.displayName || c.id)}</option>`)
          .join("")
      : '<option value="">（未检测到客户端）</option>';
    if ([...src.options].some((o) => o.value === prevSrc)) src.value = prevSrc;

    const dstList = [...writable];
    if (readInstalled.some((c) => c.id === "trae-solo") && !dstList.some((c) => c.id === "trae-solo")) {
      dstList.push({ id: "trae-solo", displayName: "Trae（只读迁出）", canWrite: false });
    }
    dst.innerHTML =
      '<option value="">迁移到…</option>' +
      (dstList.length
        ? dstList
            .map((c) => `<option value="${c.id}">${escapeHtml(c.displayName || c.id)}</option>`)
            .join("")
        : "");
    if ([...dst.options].some((o) => o.value === prevDst)) dst.value = prevDst"""
text = text[:start] + new + text[end:]
p.write_text(text, encoding="utf-8")
print("patched", start, end)

/* SessionHarbor renderer */
const $ = (s) => document.querySelector(s);
const status = (t) => { $("#status").textContent = t; };

let sessions = [];
let activeId = null;
let activeClient = null;
let watching = false;

function fmtTs(ms) {
  if (!ms) return "-";
  return new Date(ms).toLocaleString();
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function bindItems(root) {
  root.querySelectorAll(".item").forEach((node) => {
    node.addEventListener("click", () => {
      root.querySelectorAll(".item").forEach((n) => n.classList.remove("active"));
      node.classList.add("active");
      openSession(node.dataset.client, node.dataset.id);
    });
  });
}

function itemHtml(s) {
  return `
    <div class="item" data-client="${s.client}" data-id="${s.id}">
      <div class="t">${escapeHtml(s.title || s.id)}</div>
      <div class="m">${fmtTs(s.updatedAtMs || s.createdAtMs)} · ${s.messageCount ?? "-"} 条</div>
    </div>`;
}

const GROUP_PREVIEW = 5;

function renderList(items) {
  const el = $("#list");
  $("#listCount").textContent = `${items.length} 个会话`;
  if (!items.length) {
    el.innerHTML = '<div class="empty">无结果</div>';
    return;
  }

  // 按 group（cwd 目录名 / project）分组；无 group 归入「未分组」
  const map = new Map();
  for (const s of items) {
    const g = (s.group || "").trim() || "未分组";
    const list = map.get(g) ?? [];
    list.push(s);
    map.set(g, list);
  }
  // 组按最新会话时间排序
  const groups = [...map.entries()].sort((a, b) => {
    const ta = Math.max(...a[1].map((x) => x.updatedAtMs || x.createdAtMs || 0));
    const tb = Math.max(...b[1].map((x) => x.updatedAtMs || x.createdAtMs || 0));
    return tb - ta;
  });

  el.innerHTML = groups
    .map(([name, list], gi) => {
      const preview = list.slice(0, GROUP_PREVIEW);
      const rest = list.length - preview.length;
      return `
      <section class="group" data-group="${escapeHtml(name)}">
        <div class="group-head" data-gi="${gi}">
          <span class="chev">▼</span>
          <span class="folder">📁</span>
          <span class="name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
          <span class="count">${list.length}</span>
        </div>
        <div class="group-body">
          ${preview.map(itemHtml).join("")}
          ${rest > 0 ? `<div class="more" data-gi="${gi}" data-rest="${rest}">显示更多 ${rest} 条</div>` : ""}
        </div>
      </section>`;
    })
    .join("");

  // 折叠/展开
  el.querySelectorAll(".group-head").forEach((head) => {
    head.addEventListener("click", () => {
      head.closest(".group")?.classList.toggle("collapsed");
    });
  });

  // 显示更多：展开该组全部
  el.querySelectorAll(".more").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const gi = Number(btn.dataset.gi);
      const [, list] = groups[gi];
      const section = btn.closest(".group");
      const body = section.querySelector(".group-body");
      body.innerHTML = list.map(itemHtml).join("");
      bindItems(body);
    });
  });

  bindItems(el);
}

function toolbarHtml(client, id) {
  return `
    <div class="viewer-toolbar">
      <button id="btnExportMd">导出 Markdown</button>
      <button id="btnExportHtml">导出 HTML</button>
      <span class="chip">${escapeHtml(client)} / ${escapeHtml(id.slice(0, 36))}</span>
    </div>`;
}

async function openSession(client, id) {
  activeId = id;
  activeClient = client;
  status(`读取 ${client} / ${id} …`);
  try {
    const data = await window.harbor.read(client, id);
    const s = data.session;
    const parts = [
      toolbarHtml(client, id),
      `<div class="meta"><strong>${escapeHtml(s.title)}</strong><br/>` +
        `${escapeHtml(s.sourceClient)} · <code>${escapeHtml(s.sourceSessionId)}</code>` +
        (s.cwd ? ` · <code>${escapeHtml(s.cwd)}</code>` : "") +
        (s.model ? ` · ${escapeHtml(s.model)}` : "") +
        `</div>`,
    ];
    for (const item of data.items) {
      if (item.type === "message") {
        parts.push(
          `<div class="msg ${item.role}"><div class="hd">${item.role}</div><pre>${escapeHtml(item.text)}</pre></div>`,
        );
      } else if (item.type === "thinking") {
        parts.push(
          `<details class="msg tool"><summary class="hd">thinking · ${escapeHtml((item.text || "").length)} chars</summary><pre>${escapeHtml(item.text.slice(0, 4000))}</pre></details>`,
        );
      } else if (item.type === "tool_call") {
        parts.push(
          `<details class="msg tool"><summary class="hd">tool_call · ${escapeHtml(item.toolName)} · ${escapeHtml(item.callId)}</summary><pre class="muted">${escapeHtml(item.timestamp || "")}</pre></details>`,
        );
      } else if (item.type === "tool_output") {
        parts.push(
          `<details class="msg tool ${item.isError ? "err" : ""}"><summary class="hd">tool_output${item.isError ? " · error" : ""}</summary><pre>${escapeHtml((item.output || "").slice(0, 4000))}</pre></details>`,
        );
      }
    }
    $("#viewer").innerHTML = parts.join("");
    $("#btnExportMd")?.addEventListener("click", async () => {
      const r = await window.harbor.exportMd(client, id);
      status(r.canceled ? "已取消导出" : `已导出 ${r.filePath}`);
    });
    $("#btnExportHtml")?.addEventListener("click", async () => {
      const html = await window.harbor.exportHtml(client, id);
      const blob = new Blob([html], { type: "text/html" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${id}.html`;
      a.click();
      status("HTML 已下载");
    });
    status(`已加载 ${data.items.length} 个条目`);
  } catch (e) {
    $("#viewer").innerHTML = `<div class="empty">读取失败: ${escapeHtml(e.message || e)}</div>`;
    status("读取失败");
  }
}

async function loadList() {
  const client = $("#client").value;
  $("#listSrc").textContent = client;
  const kw = $("#filter").value.trim();
  status(`加载 ${client} 列表…`);
  try {
    sessions = await window.harbor.list(client, kw ? { titles: [kw] } : undefined);
    renderList(sessions);
    status(`${client}: ${sessions.length} 个会话`);
  } catch (e) {
    $("#list").innerHTML = `<div class="empty">${escapeHtml(e.message || e)}</div>`;
    status("列表失败");
  }
}

async function doSearch() {
  const q = $("#query").value.trim();
  if (!q) return;
  status(`搜索「${q}」…`);
  const res = await window.harbor.search(q, 30);
  if (res.error) {
    status(res.error);
    return;
  }
  const items = res.hits.map((h) => ({
    id: h.sessionId,
    client: h.sourceClient,
    title: h.title,
    messageCount: undefined,
    group: h.sourceClient,
  }));
  $("#listSrc").textContent = "search";
  renderList(items);
  status(`命中 ${items.length} 条 · ${res.ms}ms`);
}

async function doScan() {
  status("扫描索引中，请稍候…");
  $("#btnScan").disabled = true;
  try {
    const r = await window.harbor.scan("all");
    status(`索引完成 ${r.indexed} 条 / 总库 ${r.total} · ${r.ms}ms → ${r.indexPath}`);
  } catch (e) {
    status(`扫描失败: ${e.message || e}`);
  } finally {
    $("#btnScan").disabled = false;
  }
}

async function toggleWatch() {
  if (!watching) {
    await window.harbor.watchStart();
    watching = true;
    $("#btnWatch").classList.add("on");
    $("#btnWatch").textContent = "监听中";
    status("增量 watcher 已启动，客户端文件变更会自动刷新索引");
  } else {
    await window.harbor.watchStop();
    watching = false;
    $("#btnWatch").classList.remove("on");
    $("#btnWatch").textContent = "监听";
    status("增量 watcher 已停止");
  }
}

async function doMigrate() {
  if (!activeId || !activeClient) {
    status("请先选择一个会话");
    return;
  }
  const to = $("#migrateTo").value;
  if (!to) {
    status("请选择目标客户端");
    return;
  }
  if (to === activeClient) {
    status("目标与源相同");
    return;
  }
  if (activeClient === "chatgpt-export") {
    // chatgpt-export 只读，仍可作为源迁出
  }
  const dry = !confirm(
    `将选中会话从 ${activeClient} 迁移到 ${to}？\n\n确定 = 真实写入（自动备份）\n取消 = 仅预览 dry-run`,
  );
  status(dry ? "dry-run…" : "迁移中…");
  $("#btnMigrate").disabled = true;
  try {
    const r = await window.harbor.migrate({
      from: activeClient,
      to,
      ids: [activeId],
      dryRun: dry,
      yes: !dry,
      overwrite: false,
    });
    if (r.error) {
      status(r.error);
      return;
    }
    const s = r.report;
    status(
      `迁移完成: 成功 ${s.success} 跳过 ${s.skipped} 失败 ${s.failed} · ${dry ? "dry-run" : "已写入"}`,
    );
    $("#viewer").insertAdjacentHTML(
      "afterbegin",
      `<div class="msg"><div class="hd">迁移报告</div><pre>${escapeHtml(r.text)}</pre></div>`,
    );
    if (!dry && s.success > 0) loadList();
  } catch (e) {
    status(`迁移失败: ${e.message || e}`);
  } finally {
    $("#btnMigrate").disabled = false;
  }
}

async function refreshClients() {
  try {
    const list = await window.harbor.discover();
    $("#clients").innerHTML = list
      .map(
        (c) =>
          `<span class="chip ${c.ok ? "ok" : "err"}" title="${escapeHtml(c.info || c.error || "")}">${c.id}${c.ok ? "" : " ✗"}</span>`,
      )
      .join("");
  } catch {
    /* ignore */
  }
}

$("#btnList").addEventListener("click", loadList);
$("#btnSearch").addEventListener("click", doSearch);
$("#btnScan").addEventListener("click", doScan);
$("#btnWatch").addEventListener("click", toggleWatch);
$("#btnMigrate").addEventListener("click", doMigrate);
$("#filter").addEventListener("keydown", (e) => e.key === "Enter" && loadList());
$("#query").addEventListener("keydown", (e) => e.key === "Enter" && doSearch());
$("#client").addEventListener("change", loadList);

refreshClients().then(loadList);

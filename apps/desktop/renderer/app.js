/* SessionHarbor renderer */
const $ = (s) => document.querySelector(s);
const status = (t) => { $("#status").textContent = t; };

function harborApi() {
  if (!window.harbor || typeof window.harbor.discover !== "function") {
    const err = new Error(
      "preload 未注入（window.harbor 不可用）。请用 electron 启动本应用，不要直接打开 HTML。",
    );
    throw err;
  }
  return window.harbor;
}

let sessions = [];
let activeId = null;
let activeClient = null;
let activeGroup = null;
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
  const found = sessions.find((s) => s.id === id && s.client === client);
  activeGroup = found?.group || null;
  status(`读取 ${client} / ${id} …`);
  try {
    const data = await harborApi().read(client, id);
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
      const r = await harborApi().exportMd(client, id);
      status(r.canceled ? "已取消导出" : `已导出 ${r.filePath}`);
    });
    $("#btnExportHtml")?.addEventListener("click", async () => {
      const html = await harborApi().exportHtml(client, id);
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
  if (!client) {
    $("#list").innerHTML = '<div class="empty">未检测到本机已安装的客户端数据目录</div>';
    $("#listSrc").textContent = "-";
    status("无可用客户端");
    return;
  }
  $("#listSrc").textContent = client;
  const kw = $("#filter").value.trim();
  status(`加载 ${client} 列表…`);
  try {
    sessions = await harborApi().list(client, kw ? { titles: [kw] } : undefined);
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
  let res;
  try {
    res = await harborApi().search(q, 30);
  } catch (e) {
    status(`搜索失败: ${e.message || e}`);
    return;
  }
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
    const r = await harborApi().scan("all");
    status(`索引完成 ${r.indexed} 条 / 总库 ${r.total} · ${r.ms}ms → ${r.indexPath}`);
  } catch (e) {
    status(`扫描失败: ${e.message || e}`);
  } finally {
    $("#btnScan").disabled = false;
  }
}

async function toggleWatch() {
  if (!watching) {
    await harborApi().watchStart();
    watching = true;
    $("#btnWatch").classList.add("on");
    $("#btnWatch").textContent = "监听中";
    status("增量 watcher 已启动，客户端文件变更会自动刷新索引");
  } else {
    await harborApi().watchStop();
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
    `将选中会话从 ${activeClient} 迁移到 ${to}？\n\n确定 = 真实写入（目标已存在则覆盖）\n取消 = 仅预览 dry-run`,
  );
  status(dry ? "dry-run…" : "迁移中…");
  $("#btnMigrate").disabled = true;
  try {
    const r = await harborApi().migrate({
      from: activeClient,
      to,
      ids: [activeId],
      dryRun: dry,
      yes: !dry,
      overwrite: true,
    });
    if (r.error) {
      status(r.error);
      return;
    }
    const s = r.report;
    const skipReason = r.report.items?.find((i) => i.status === "skipped")?.message || "";
    status(
      `迁移: 成功 ${s.success} 跳过 ${s.skipped} 失败 ${s.failed}${skipReason ? " · " + skipReason : ""} · ${dry ? "dry-run" : "已写入"}`,
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
    const list = await harborApi().discover();
    // 徽章：只显示已安装
    $("#clients").innerHTML = list
      .filter((c) => c.installed || c.ok)
      .map((c) => {
        const ok = c.installed ?? c.ok;
        const label = c.displayName || c.id;
        return `<span class="chip ${ok ? "ok" : "err"}" title="${escapeHtml(c.info || c.error || "")}">${escapeHtml(label)}</span>`;
      })
      .join("");

    // 下拉框：只保留本机已检测到的客户端（未安装不得出现）
    const installed = list.filter((c) => (c.installed ?? c.ok) && c.canWrite !== false);
    const readInstalled = list.filter((c) => c.installed ?? c.ok);
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

    dst.innerHTML =
      '<option value="">迁移到…</option>' +
      (installed.length
        ? installed
            .map((c) => `<option value="${c.id}">${escapeHtml(c.displayName || c.id)}</option>`)
            .join("")
        : "");
    if ([...dst.options].some((o) => o.value === prevDst)) dst.value = prevDst;

    const n = readInstalled.length;
    status(`已自动检测本机 ${n} 个客户端可解析会话库`);
    return list;
  } catch (e) {
    status(`客户端探测失败: ${e.message || e}`);
    $("#client").innerHTML = '<option value="">（preload 未注入）</option>';
    return [];
  }
}

async function doSync(direction = "push") {
  const scope = $("#syncScope").value;
  const opts = { scope, direction };
  if (scope === "client") {
    if (!$("#client").value) {
      status("请先选择来源客户端");
      return;
    }
    opts.client = $("#client").value;
  } else if (scope === "group") {
    const g = activeGroup || prompt("输入项目/文件夹名（group）:");
    if (!g) {
      status("未指定项目");
      return;
    }
    opts.group = g;
  } else if (scope === "session") {
    if (!activeId || !activeClient) {
      status("请先选择一条会话");
      return;
    }
    opts.sessionId = activeId;
    opts.client = activeClient;
  }
  const label = direction === "pull" ? "从云拉取" : "推送到云";
  const dry = !confirm(
    `${label} · 范围 ${scope}${opts.group ? " / " + opts.group : ""}\n\n确定 = 真实执行\n取消 = dry-run`,
  );
  status(`${label}…`);
  $("#btnSync").disabled = true;
  $("#btnPull").disabled = true;
  try {
    const r = await harborApi().sync({ ...opts, dryRun: dry });
    status(
      `${label}: 上传 ${r.report.uploaded} 下载 ${r.report.downloaded} 跳过 ${r.report.skipped} 失败 ${r.report.failed}`,
    );
    $("#viewer").insertAdjacentHTML(
      "afterbegin",
      `<div class="msg"><div class="hd">云同步报告 (${r.direction})</div><pre>${escapeHtml(r.text)}\n\n云端: ${escapeHtml(r.cloudRoot || "")}</pre></div>`,
    );
  } catch (e) {
    status(`${label}失败: ${e.message || e}`);
  } finally {
    $("#btnSync").disabled = false;
    $("#btnPull").disabled = false;
  }
}

$("#btnList").addEventListener("click", loadList);
$("#btnSearch").addEventListener("click", doSearch);
$("#btnScan").addEventListener("click", doScan);
$("#btnWatch").addEventListener("click", toggleWatch);
$("#btnMigrate").addEventListener("click", doMigrate);
$("#btnSync").addEventListener("click", () => doSync("push"));
$("#btnPull").addEventListener("click", () => doSync("pull"));
$("#filter").addEventListener("keydown", (e) => e.key === "Enter" && loadList());
$("#query").addEventListener("keydown", (e) => e.key === "Enter" && doSearch());
$("#client").addEventListener("change", loadList);

// 主进程自动扫描完成后刷新
try {
  if (window.harbor?.onAutoScanDone) {
    window.harbor.onAutoScanDone((payload) => {
      status(
        `启动自动扫描完成：已索引 ${payload?.installed ?? 0} 个客户端` +
          (payload?.clients?.length ? `（${payload.clients.join("、")}）` : ""),
      );
      void loadList();
    });
  }
} catch {
  /* ignore */
}

refreshClients().then(loadList);

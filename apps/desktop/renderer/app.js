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
/** 多选：key = `${client}::${id}` */
const selected = new Set();
/** Shift 连选锚点：key 或 null */
let lastSelKey = null;

function selKey(client, id) {
  return `${client}::${id}`;
}

function selectedSessions() {
  const out = [];
  for (const key of selected) {
    const i = key.indexOf("::");
    if (i < 0) continue;
    const client = key.slice(0, i);
    const id = key.slice(i + 2);
    const s = sessions.find((x) => x.client === client && x.id === id);
    out.push(s ? { ...s, client, id } : { client, id, title: id });
  }
  return out;
}

function updateSelUI() {
  const n = selected.size;
  const el = $("#selInfo");
  if (el) el.textContent = n > 0 ? `已选 ${n} 个会话` : "多选";
  const clearBtn = $("#btnClearSel");
  if (clearBtn) clearBtn.classList.toggle("hidden", n === 0);
  $("#listCount").textContent = `${sessions.length} 个会话${n ? ` · 已选 ${n}` : ""}`;
}

function clearSelection() {
  selected.clear();
  lastSelKey = null;
  document.querySelectorAll(".item.selected").forEach((n) => n.classList.remove("selected"));
  document.querySelectorAll(".item-check.checked").forEach((n) => {
    n.classList.remove("checked");
    n.setAttribute("aria-pressed", "false");
    n.innerHTML = "";
  });
  document.querySelectorAll(".group-check.checked").forEach((n) => {
    n.classList.remove("checked");
    n.setAttribute("aria-pressed", "false");
    n.innerHTML = "";
  });
  updateSelUI();
}

function setCheckVisual(node, on) {
  node.classList.toggle("checked", on);
  node.setAttribute("aria-pressed", on ? "true" : "false");
  node.innerHTML = on ? '<span class="tick"></span>' : "";
}

function toggleItemSel(node, force) {
  const client = node.dataset.client;
  const id = node.dataset.id;
  const key = selKey(client, id);
  const on = force != null ? force : !selected.has(key);
  if (on) selected.add(key);
  else selected.delete(key);
  node.classList.toggle("selected", on);
  setCheckVisual(node.querySelector(".item-check"), on);
  lastSelKey = key;
  // 同步该组头勾选
  const section = node.closest(".group");
  if (section) syncGroupHead(section);
  updateSelUI();
}

function syncGroupHead(section) {
  const boxes = [...section.querySelectorAll(".item")];
  const all = boxes.length > 0 && boxes.every((b) => selected.has(selKey(b.dataset.client, b.dataset.id)));
  const gc = section.querySelector(".group-check");
  if (gc) setCheckVisual(gc, all);
}

/** Shift 点击：从锚点到当前项连选 */
function rangeSelect(node, on) {
  const all = [...document.querySelectorAll(".item")];
  const cur = all.indexOf(node);
  if (cur < 0) return toggleItemSel(node, on);
  const anchorKey = lastSelKey;
  let start = cur;
  if (anchorKey) {
    const ai = all.findIndex((n) => selKey(n.dataset.client, n.dataset.id) === anchorKey);
    if (ai >= 0) start = ai;
  }
  const [a, b] = start <= cur ? [start, cur] : [cur, start];
  for (let i = a; i <= b; i++) {
    const key = selKey(all[i].dataset.client, all[i].dataset.id);
    if (on) selected.add(key);
    else selected.delete(key);
    all[i].classList.toggle("selected", on);
    setCheckVisual(all[i].querySelector(".item-check"), on);
  }
  document.querySelectorAll(".group").forEach(syncGroupHead);
  updateSelUI();
}

function toggleGroupSel(section) {
  const boxes = [...section.querySelectorAll(".item")];
  const all = boxes.length > 0 && boxes.every((b) => selected.has(selKey(b.dataset.client, b.dataset.id)));
  for (const b of boxes) {
    const on = !all;
    const key = selKey(b.dataset.client, b.dataset.id);
    if (on) selected.add(key);
    else selected.delete(key);
    b.classList.toggle("selected", on);
    setCheckVisual(b.querySelector(".item-check"), on);
  }
  lastSelKey = boxes.length ? selKey(boxes[boxes.length - 1].dataset.client, boxes[boxes.length - 1].dataset.id) : null;
  syncGroupHead(section);
  updateSelUI();
}

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

/** 来源客户端 → 左侧轨颜色（海事信号灯） */
function clientColor(id) {
  const map = {
    alink: "#3ec6f0",
    "claude-code": "#d2a8ff",
    workbuddy: "#7ee7a8",
    codex: "#e6b84d",
    mimo: "#ff8f6b",
    "deepseek-harness": "#6eb6ff",
    devin: "#f0a0c8",
    "trae-solo": "#5ad4a0",
    cursor: "#9ecbff",
    vscode: "#4aa8ff",
    hermes: "#f0c14a",
    openclaw: "#9adf6e",
    "chatgpt-export": "#a0b4d0",
  };
  return map[id] || "#3ec6f0";
}

function emptyHtml(title, hint, icon = "◎") {
  return `<div class="empty"><div class="empty-icon">${icon}</div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(hint)}</small></div>`;
}

function bindItems(root) {
  root.querySelectorAll(".item").forEach((node) => {
    node.addEventListener("click", (e) => {
      const key = selKey(node.dataset.client, node.dataset.id);
      const isCheck = e.target.closest(".item-check");
      // Shift：连选；Ctrl/Cmd 或复选框：单点切换
      if (isCheck || e.ctrlKey || e.metaKey || e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey && !isCheck) rangeSelect(node, true);
        else if (e.shiftKey && isCheck) rangeSelect(node, !selected.has(key));
        else toggleItemSel(node, isCheck ? !selected.has(key) : undefined);
        return;
      }
      root.querySelectorAll(".item").forEach((n) => n.classList.remove("active"));
      node.classList.add("active");
      openSession(node.dataset.client, node.dataset.id);
    });
  });
}

function itemHtml(s) {
  const color = clientColor(s.client);
  const ts = s.updatedAtMs || s.createdAtMs;
  const key = selKey(s.client, s.id);
  const on = selected.has(key);
  return `
    <div class="item${on ? " selected" : ""}" data-client="${escapeHtml(s.client)}" data-id="${escapeHtml(s.id)}" style="--rail:${color}">
      <button type="button" class="item-check${on ? " checked" : ""}" title="多选（Ctrl/Shift 连选）" aria-pressed="${on ? "true" : "false"}">${on ? '<span class="tick"></span>' : ""}</button>
      <div class="item-body">
        <div class="t">${escapeHtml(s.title || s.id)}</div>
        <div class="m">
          <span class="src-dot" style="background:${color}"></span>
          <time>${fmtTs(ts)}</time>
          <span>·</span>
          <span>${s.messageCount ?? "-"} 条</span>
        </div>
      </div>
    </div>`;
}

const GROUP_PREVIEW = 5;

function renderList(items) {
  const el = $("#list");
  $("#listCount").textContent = `${items.length} 个会话`;
  if (!items.length) {
    el.innerHTML = emptyHtml("无会话", "换一个来源客户端，或调整标题关键字", "⌕");
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
          <button type="button" class="group-check" title="全选/取消本组" aria-pressed="false"></button>
          <span class="chev">▼</span>
          <span class="folder">◆</span>
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

  // 折叠/展开；组头勾选全选
  el.querySelectorAll(".group-head").forEach((head) => {
    head.addEventListener("click", (e) => {
      if (e.target.closest(".group-check")) {
        e.stopPropagation();
        toggleGroupSel(head.closest(".group"));
        return;
      }
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
      syncGroupHead(section);
      updateSelUI();
    });
  });

  bindItems(el);
  el.querySelectorAll(".group").forEach(syncGroupHead);
  updateSelUI();
}

function toolbarHtml(client, id) {
  return `
    <div class="viewer-toolbar">
      <button id="btnExportMd">导出 Markdown</button>
      <button id="btnExportHtml">导出 HTML</button>
      <span class="chip">${escapeHtml(client)} / ${escapeHtml(String(id).slice(0, 36))}</span>
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
          `<div class="msg ${item.role}"><div class="hd">${escapeHtml(item.role)}</div><pre>${escapeHtml(item.text)}</pre></div>`,
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
    $("#viewer").innerHTML = emptyHtml("读取失败", e.message || String(e), "!");
    status("读取失败");
  }
}

async function loadList() {
  const client = $("#client").value;
  if (!client) {
    $("#list").innerHTML = emptyHtml("未检测到客户端", "本机没有可解析的 AI 客户端数据目录", "⚓");
    $("#listSrc").textContent = "—";
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
    $("#list").innerHTML = emptyHtml("列表失败", e.message || String(e), "!");
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
  const picked = selectedSessions();
  const useMulti = picked.length > 0;
  const fromClient = useMulti ? picked[0].client : activeClient;
  const ids = useMulti ? picked.map((p) => p.id) : activeId ? [activeId] : [];
  if (!ids.length || !fromClient) {
    status("请先选择会话（可多选：点 ☐ 或 Ctrl/Shift 点击）");
    return;
  }
  const to = $("#migrateTo").value;
  if (!to) {
    status("请选择目标客户端");
    return;
  }
  if (to === fromClient) {
    status("目标与源相同");
    return;
  }
  // 多选时若混入其它客户端，按客户端分组提示
  const clients = new Set(picked.map((p) => p.client));
  if (useMulti && clients.size > 1) {
    status(`多选含多个来源（${[...clients].join("、")}），请先只选同一来源`);
    return;
  }
  const dry = !confirm(
    `将 ${ids.length} 个会话从 ${fromClient} 迁移到 ${to}？\n\n确定 = 真实写入（目标已存在则覆盖）\n取消 = 仅预览 dry-run`,
  );
  status(dry ? "dry-run…" : `迁移 ${ids.length} 个会话…`);
  $("#btnMigrate").disabled = true;
  try {
    const r = await harborApi().migrate({
      from: fromClient,
      to,
      ids,
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
    const picked = selectedSessions();
    if (picked.length) {
      opts.sessionId = picked[0].id;
      opts.client = picked[0].client;
      if (picked.length > 1) {
        status(`云同步按单会话设计，已取多选中的第 1 个（共选 ${picked.length}）`);
      }
    } else if (activeId && activeClient) {
      opts.sessionId = activeId;
      opts.client = activeClient;
    } else {
      status("请先选择一条会话");
      return;
    }
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
$("#btnClearSel")?.addEventListener("click", clearSelection);
$("#btnSelAll")?.addEventListener("click", () => {
  document.querySelectorAll(".item").forEach((n) => toggleItemSel(n, true));
  status(`已选 ${selected.size} 个会话`);
});
$("#filter").addEventListener("keydown", (e) => e.key === "Enter" && loadList());
$("#query").addEventListener("keydown", (e) => e.key === "Enter" && doSearch());
$("#client").addEventListener("change", () => {
  clearSelection();
  loadList();
});

// ---------- 云账号 ----------
async function cloudRefresh() {
  const r = await harborApi().cloudAuth({ action: "me" });
  if (r.error && !r.loggedIn) {
    $("#cloudInfo").textContent = r.error || "未登录";
    $("#cloudCodeRow").classList.add("hidden");
    return r;
  }
  if (r.endpoint) $("#cloudEndpoint").value = r.endpoint;
  if (r.loggedIn) {
    $("#cloudInfo").textContent =
      `已登录 ${r.email}\nplan=${r.plan}  userId=${r.userId}\n` +
      `用量 sessions=${r.usage?.sessions ?? 0}  quota=${r.quota?.maxSessions ?? "-"}\n` +
      `endpoint=${r.endpoint}`;
    $("#cloudCodeRow").classList.add("hidden");
  } else {
    $("#cloudInfo").textContent = `未登录\nendpoint=${r.endpoint || ""}`;
  }
  return r;
}

async function cloudAuth(action) {
  const opts = {
    action,
    endpoint: $("#cloudEndpoint").value.trim() || undefined,
    email: $("#cloudEmail").value.trim() || undefined,
    password: $("#cloudPassword").value || undefined,
    code: $("#cloudCode").value.trim() || undefined,
  };
  const r = await harborApi().cloudAuth(opts);
  if (r.error) {
    $("#cloudInfo").textContent = r.error;
    status(`云账号: ${r.error}`);
    return r;
  }
  if (r.verifyCode) {
    $("#cloudCodeRow").classList.remove("hidden");
    $("#cloudCode").value = r.verifyCode;
    status(`注册成功，验证码 ${r.verifyCode}（请验证邮箱）`);
  } else if (action === "verify") {
    status("邮箱验证成功");
  } else if (action === "logout") {
    status("已登出");
  } else if (action === "login") {
    status(
      `登录成功 plan=${r.plan}${r.emailVerified === false ? "（邮箱未验证）" : ""}`,
    );
  }
  await cloudRefresh();
  return r;
}

$("#btnCloud").addEventListener("click", () => {
  $("#cloudModal").classList.remove("hidden");
  void cloudRefresh();
});
$("#cloudClose").addEventListener("click", () => {
  $("#cloudModal").classList.add("hidden");
});
$("#cloudLogin").addEventListener("click", () => void cloudAuth("login"));
$("#cloudRegister").addEventListener("click", () => void cloudAuth("register"));
$("#cloudVerify").addEventListener("click", () => void cloudAuth("verify"));
$("#cloudLogout").addEventListener("click", () => void cloudAuth("logout"));

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

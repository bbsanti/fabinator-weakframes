/*
 * app.js — Fabinator WeakFrames UI + File System Access + ffmpeg.wasm export.
 * Requires core.js (window.FabCore) loaded first.
 */
(function () {
  'use strict';
  const C = window.FabCore;

  // ------------------------------------------------------------------ helpers
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function fmtBytes(n) {
    if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function extOf(name) { const i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i + 1).toLowerCase(); }
  function canceledError() { return Object.assign(new Error('canceled'), { canceled: true }); }

  let toastTimer = null;
  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || 2600);
  }

  function confirmModal({ title, bodyHTML, okLabel, danger }) {
    return new Promise((resolve) => {
      const rootEl = $('#modalRoot');
      rootEl.innerHTML =
        '<div class="modal-backdrop"><div class="modal">' +
        '<h3>' + esc(title) + '</h3>' +
        '<div class="modal-body">' + bodyHTML + '</div>' +
        '<div class="modal-actions">' +
        '<button class="btn ghost" id="mCancel">Cancel</button>' +
        '<button class="btn ' + (danger ? 'danger' : 'primary') + '" id="mOk">' + esc(okLabel || 'OK') + '</button>' +
        '</div></div></div>';
      rootEl.hidden = false;
      const done = (v) => { rootEl.hidden = true; rootEl.innerHTML = ''; resolve(v); };
      $('#mCancel').onclick = () => done(false);
      $('#mOk').onclick = () => done(true);
      rootEl.querySelector('.modal-backdrop').addEventListener('mousedown', (e) => {
        if (e.target === e.currentTarget) done(false);
      });
    });
  }
  function modalOpen() { return !$('#modalRoot').hidden; }

  // ------------------------------------------------------------------ state
  const SKIP_DIRS = new Set(['to_delete', '$recycle.bin', 'system volume information', 'node_modules']);

  const S = {
    root: null,          // FileSystemDirectoryHandle
    rootName: '',
    dirHandles: new Map(), // relDir -> directory handle ('' = root)
    items: [],           // pairs from core.buildPairs + {status, trashNames}
    unpaired: [],        // {relDir, id, name, ext, kind:'plain'|'seg', status, trashName}
    conflicts: [],
    ignored: 0,
    idx: -1,
    view: 'orig',        // 'orig' | 'seg' | 'overlay'
    undoStack: [],
    trashLiveCount: 0,   // files currently sitting in to_delete (incl. previous sessions)
    urlCache: new Map(), // item index -> {orig, seg}
    scanGen: 0,          // bumped on every rescan; stale async work checks it
    exporting: false,
    busy: false,         // a move/restore in flight
    ffmpeg: null,
    ffReady: false,
    enginePromise: null, // in-flight or completed loadEngine() promise (memoized)
    encoders: null,      // Set of encoder names, filled after probe
    logRing: [],
    probeSink: null,
    lastFrameSeen: 0,
    encTotal: 0,
    cancelFlag: false,
    currentTab: 'welcome',
  };

  // ------------------------------------------------------------------ tabs
  function switchTab(name) {
    S.currentTab = name;
    $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tabpane').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
    if (name === 'export') refreshSource();
  }

  // ------------------------------------------------------------------ scanning
  async function scanTree(dirHandle, rel, files) {
    S.dirHandles.set(rel, dirHandle);
    for await (const [name, h] of dirHandle.entries()) {
      if (h.kind === 'directory') {
        const lower = name.toLowerCase();
        if (SKIP_DIRS.has(lower) || name.startsWith('.')) {
          if (lower === 'to_delete' && rel === '') S.trashLiveCount += await countFiles(h);
          continue;
        }
        await scanTree(h, rel ? rel + '/' + name : name, files);
      } else {
        files.push({ relDir: rel, name });
      }
    }
  }

  async function countFiles(dirHandle) {
    let n = 0;
    for await (const [, h] of dirHandle.entries()) {
      if (h.kind === 'directory') n += await countFiles(h);
      else n++;
    }
    return n;
  }

  async function* walkFiles(dirHandle, rel) {
    for await (const [name, h] of dirHandle.entries()) {
      if (h.kind === 'directory') yield* walkFiles(h, rel ? rel + '/' + name : name);
      else yield { rel, name, dir: dirHandle };
    }
  }

  async function openFolder() {
    if (!window.showDirectoryPicker) return;
    if (S.busy || S.exporting) { toast('Wait for the current operation to finish'); return; }
    let handle;
    try {
      handle = await window.showDirectoryPicker({ id: 'fabinator-frames', mode: 'readwrite' });
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      toast('Could not open folder: ' + e.message);
      return;
    }
    if (S.busy || S.exporting) { toast('Folder not loaded — an operation started meanwhile'); return; }
    S.root = handle;
    S.rootName = handle.name;
    await rescan();
  }

  async function rescan() {
    if (!S.root) return;
    if (S.busy || S.exporting) { toast('Wait for the current operation to finish'); return; }
    S.scanGen++;
    clearUrlCache();
    S.dirHandles = new Map();
    S.undoStack = [];
    S.trashLiveCount = 0;
    S.items = [];
    S.unpaired = [];
    S.conflicts = [];
    S.idx = -1;
    $('#viewerEmpty').textContent = 'Scanning…';
    $('#viewerEmpty').hidden = false;

    const files = [];
    try {
      await scanTree(S.root, '', files);
    } catch (e) {
      toast('Scan failed: ' + e.message, 5000);
      return;
    }
    const res = C.buildPairs(files);
    S.items = res.pairs.map((p) => ({ ...p, status: 'active', trashNames: null }));
    S.unpaired = res.unpairedPlain.map((u) => ({ ...u, kind: 'plain', status: 'active', trashName: null }))
      .concat(res.unpairedSeg.map((u) => ({ ...u, kind: 'seg', status: 'active', trashName: null })));
    S.conflicts = res.conflicts;
    S.ignored = res.ignored;

    $('#rootChip').textContent = '📁 ' + S.rootName;
    $('#rootChip').hidden = false;
    $('#btnRescan').hidden = false;

    renderPairList();
    renderSidebar();
    updateStats();

    const first = nextActive(-1, +1);
    if (first === -1) {
      S.idx = -1;
      $('#viewerEmpty').textContent = S.items.length
        ? 'All pairs are in to_delete.'
        : 'No #.<ext> + segmneted_#.<ext> pairs found in this folder tree.';
      $('#viewerEmpty').hidden = false;
      renderPairInfo();
    } else {
      await showPair(first);
    }
    toast('Found ' + S.items.length + ' pairs in ' + new Set(S.items.map((i) => i.relDir)).size + ' folder(s)');
  }

  // ------------------------------------------------------------------ stats + sidebar
  function activeCount() { return S.items.filter((i) => i.status === 'active').length; }

  function updateStats() {
    const act = activeCount();
    const trashed = S.items.length - act;
    $('#statsChips').innerHTML =
      '<span class="chip">' + act + ' active pairs</span>' +
      (trashed ? '<span class="chip warn">' + trashed + ' marked</span>' : '') +
      (S.unpaired.filter((u) => u.status === 'active').length
        ? '<span class="chip dim">' + S.unpaired.filter((u) => u.status === 'active').length + ' unpaired</span>' : '');
    $('#trashSummary').textContent = S.trashLiveCount
      ? S.trashLiveCount + ' file(s) waiting in to_delete'
      : 'empty';
    $('#btnPurge').disabled = !S.trashLiveCount || S.exporting;
    $('#btnRestoreAll').disabled = !S.trashLiveCount || S.exporting;
    $('#btnUndo').disabled = !S.undoStack.length || S.exporting;
  }

  function renderSidebar() {
    const up = S.unpaired.filter((u) => u.status === 'active');
    const plain = up.filter((u) => u.kind === 'plain');
    const seg = up.filter((u) => u.kind === 'seg');
    let html = '';
    if (!up.length && !S.conflicts.length) {
      html = '<p class="dim">Every image has its partner. 🎯</p>';
    } else {
      if (plain.length) {
        html += '<details><summary>' + plain.length + ' original(s) with no segmented partner</summary><ul>' +
          plain.slice(0, 300).map((u) => '<li>' + esc((u.relDir ? u.relDir + '/' : '') + u.name) + '</li>').join('') +
          (plain.length > 300 ? '<li>…</li>' : '') + '</ul></details>';
      }
      if (seg.length) {
        html += '<details><summary>' + seg.length + ' segmented file(s) with no original</summary><ul>' +
          seg.slice(0, 300).map((u) => '<li>' + esc((u.relDir ? u.relDir + '/' : '') + u.name) + '</li>').join('') +
          (seg.length > 300 ? '<li>…</li>' : '') + '</ul></details>';
      }
      if (S.conflicts.length) {
        html += '<details><summary class="warn-text">' + S.conflicts.length + ' naming conflict(s) — excluded</summary><ul>' +
          S.conflicts.slice(0, 100).map((c) => '<li>' + esc((c.relDir ? c.relDir + '/' : '') + '#' + c.id + ': ' + c.names.join(', ')) + '</li>').join('') +
          '</ul></details>';
      }
    }
    if (S.ignored) html += '<p class="dim small">' + S.ignored + ' non-matching file(s) ignored (videos, Thumbs.db, …)</p>';
    $('#unpairedBody').innerHTML = html;
    $('#btnTrashUnpaired').hidden = !up.length;
    $('#btnTrashUnpaired').textContent = 'Move all ' + up.length + ' unpaired → to_delete';
  }

  const LIST_CAP = 3000;
  function renderPairList() {
    const el = $('#pairList');
    const n = Math.min(S.items.length, LIST_CAP);
    let html = '';
    for (let i = 0; i < n; i++) {
      const it = S.items[i];
      html += '<div class="prow' + (it.status === 'trash' ? ' trash' : '') + (i === S.idx ? ' cur' : '') + '" data-i="' + i + '">' +
        '<span class="pid">#' + it.id + '</span>' +
        '<span class="pdir" title="' + esc(it.relDir || '(root)') + '">' + esc(it.relDir || '·') + '</span>' +
        '<span class="pst">' + (it.status === 'trash' ? '🗑' : '') + '</span></div>';
    }
    if (S.items.length > LIST_CAP) html += '<div class="dim small">…' + (S.items.length - LIST_CAP) + ' more not listed</div>';
    el.innerHTML = html;
  }

  function refreshListRow(i) {
    const row = $('#pairList .prow[data-i="' + i + '"]');
    if (!row) return;
    row.classList.toggle('trash', S.items[i].status === 'trash');
    row.querySelector('.pst').textContent = S.items[i].status === 'trash' ? '🗑' : '';
  }

  function highlightListRow() {
    $$('#pairList .prow.cur').forEach((r) => r.classList.remove('cur'));
    const row = $('#pairList .prow[data-i="' + S.idx + '"]');
    if (row) { row.classList.add('cur'); row.scrollIntoView({ block: 'nearest' }); }
  }

  // ------------------------------------------------------------------ viewer
  let loadToken = 0;

  async function getUrls(i) {
    let u = S.urlCache.get(i);
    if (u) return u;
    const gen = S.scanGen;
    const it = S.items[i];
    // trashed pairs are viewable too — read them from to_delete under their staged names
    let srcDir, plainName, segName;
    if (it.status === 'trash' && it.trashNames) {
      srcDir = await trashDir(it.relDir, false);
      plainName = it.trashNames.plain;
      segName = it.trashNames.seg;
    } else {
      srcDir = S.dirHandles.get(it.relDir);
      if (!srcDir) throw new Error('missing dir handle for ' + it.relDir);
      plainName = it.plainName;
      segName = it.segName;
    }
    const orig = URL.createObjectURL(await (await srcDir.getFileHandle(plainName)).getFile());
    let seg;
    try {
      seg = URL.createObjectURL(await (await srcDir.getFileHandle(segName)).getFile());
    } catch (e) {
      URL.revokeObjectURL(orig); // don't leak the first URL when the second fails
      throw e;
    }
    if (gen !== S.scanGen) {
      // a rescan happened while we were reading — don't poison the fresh cache
      URL.revokeObjectURL(orig);
      URL.revokeObjectURL(seg);
      throw canceledError();
    }
    u = { orig, seg };
    S.urlCache.set(i, u);
    return u;
  }

  function evictUrls(keepCenter) {
    for (const [k, u] of S.urlCache) {
      if (Math.abs(k - keepCenter) > 4) {
        URL.revokeObjectURL(u.orig);
        URL.revokeObjectURL(u.seg);
        S.urlCache.delete(k);
      }
    }
  }
  function clearUrlCache() {
    for (const [, u] of S.urlCache) { URL.revokeObjectURL(u.orig); URL.revokeObjectURL(u.seg); }
    S.urlCache.clear();
  }
  function invalidateUrl(i) {
    const u = S.urlCache.get(i);
    if (u) { URL.revokeObjectURL(u.orig); URL.revokeObjectURL(u.seg); S.urlCache.delete(i); }
  }

  async function showPair(i) {
    if (i < 0 || i >= S.items.length) return;
    S.idx = i;
    const token = ++loadToken;
    highlightListRow();
    renderPairInfo();
    let urls;
    try {
      urls = await getUrls(i);
    } catch (e) {
      if (token !== loadToken || (e && e.canceled)) return;
      $('#viewerEmpty').textContent = 'Could not read files for this pair (' + e.message + ')';
      $('#viewerEmpty').hidden = false;
      return;
    }
    if (token !== loadToken) return;
    $('#imgOrig').src = urls.orig;
    $('#imgSeg').src = urls.seg;
    $('#viewerEmpty').hidden = true;
    applyView();
    prefetchAround(i);
    evictUrls(i);
  }

  function prefetchAround(i) {
    for (const dir of [+1, -1]) {
      const j = nextActive(i, dir);
      if (j !== -1 && !S.urlCache.has(j)) {
        getUrls(j).then((u) => {
          const a = new Image(); a.src = u.orig;
          const b = new Image(); b.src = u.seg;
        }).catch(() => {});
      }
    }
  }

  function renderPairInfo() {
    if (S.idx < 0 || !S.items.length) { $('#pairInfo').innerHTML = '<span class="dim">—</span>'; $('#hudIdx').textContent = ''; return; }
    const it = S.items[S.idx];
    const pos = S.idx + 1;
    $('#pairInfo').innerHTML =
      '<span class="chip dim">' + esc(it.relDir || '(root)') + '</span> ' +
      '<span class="chip">#' + it.id + '</span> ' +
      '<span class="mono">' + esc(it.plainName) + ' ⇄ ' + esc(it.segName) + '</span>' +
      (it.status === 'trash'
        ? ' <span class="chip bad">in to_delete</span> <button class="btn small-btn" id="btnRestorePair" title="Restore this pair (R)">↩ Restore this pair</button>'
        : '');
    const rb = $('#btnRestorePair');
    if (rb) rb.onclick = () => restorePair(S.idx);
    $('#hudIdx').textContent = pos + ' / ' + S.items.length;
  }

  function applyView() {
    const io = $('#imgOrig'), is = $('#imgSeg');
    const hud = $('#hudView');
    const op = Number($('#ovlOpacity').value) / 100;
    if (S.view === 'orig') {
      io.style.display = 'block'; is.style.display = 'none'; is.style.opacity = '1';
      hud.textContent = 'ORIGINAL';
    } else if (S.view === 'seg') {
      io.style.display = 'none'; is.style.display = 'block'; is.style.opacity = '1';
      hud.textContent = 'SEGMENTED';
    } else {
      io.style.display = 'block'; is.style.display = 'block'; is.style.opacity = String(op);
      hud.textContent = 'OVERLAY ' + Math.round(op * 100) + '%';
    }
    $('#ovlWrap').hidden = S.view !== 'overlay';
    $('#btnOverlay').classList.toggle('on', S.view === 'overlay');
  }

  function toggleView() {
    S.view = S.view === 'orig' ? 'seg' : 'orig';
    applyView();
  }
  function toggleOverlay() {
    S.view = S.view === 'overlay' ? 'orig' : 'overlay';
    applyView();
  }

  // ------------------------------------------------------------------ navigation
  function nextActive(from, dir) {
    for (let i = from + dir; i >= 0 && i < S.items.length; i += dir) {
      if (S.items[i].status === 'active') return i;
    }
    return -1;
  }
  function firstActive() { return nextActive(-1, +1); }
  function lastActive() { return nextActive(S.items.length, -1); }

  async function nav(dir) {
    if (!S.items.length) return;
    const j = nextActive(S.idx, dir);
    if (j === -1) { toast(dir > 0 ? 'No later active pair' : 'No earlier active pair'); return; }
    await showPair(j);
  }

  // ------------------------------------------------------------------ file moves
  async function moveFile(srcDir, srcName, dstDir, dstName) {
    const fh = await srcDir.getFileHandle(srcName);
    if (typeof fh.move === 'function') {
      try { await fh.move(dstDir, dstName); return; } catch (e) { /* fall back to copy+delete */ }
    }
    const f = await fh.getFile();
    const out = await dstDir.getFileHandle(dstName, { create: true });
    const w = await out.createWritable();
    await w.write(f);
    await w.close();
    try {
      await srcDir.removeEntry(srcName);
    } catch (e) {
      // copy landed but the source is stuck (e.g. locked) — remove the copy so
      // a failed move never leaves a phantom duplicate behind
      try { await dstDir.removeEntry(dstName); } catch (e2) { /* keep both copies as last resort */ }
      throw e;
    }
  }

  async function uniqueName(dstDir, name) {
    const dot = name.lastIndexOf('.');
    const stem = dot < 0 ? name : name.slice(0, dot);
    const ext = dot < 0 ? '' : name.slice(dot);
    for (let k = 0; k < 50; k++) {
      const candidate = k === 0 ? name : stem + '_' + k + ext;
      try {
        await dstDir.getFileHandle(candidate); // exists → collision, keep looking
      } catch (e) {
        return candidate; // not found → free
      }
    }
    return stem + '_' + Date.now() + ext; // guaranteed-fresh fallback
  }

  // move without ever clobbering an existing destination file; returns the final name
  async function moveFileNoClobber(srcDir, srcName, dstDir, wantName) {
    const finalName = await uniqueName(dstDir, wantName);
    await moveFile(srcDir, srcName, dstDir, finalName);
    return finalName;
  }

  async function getDirByRel(base, rel, create) {
    let d = base;
    if (rel) {
      for (const seg of rel.split('/')) {
        d = await d.getDirectoryHandle(seg, { create: !!create });
      }
    }
    return d;
  }
  async function trashDir(relDir, create) {
    const td = await S.root.getDirectoryHandle('to_delete', { create: !!create });
    return getDirByRel(td, relDir, create);
  }

  async function markTrash() {
    if (S.busy || S.exporting) { toast(S.exporting ? 'Wait for the export to finish' : 'Busy…'); return; }
    const idx = S.idx; // capture — navigation may change S.idx during the awaits below
    if (idx < 0) return;
    const it = S.items[idx];
    if (it.status !== 'active') return;
    S.busy = true;
    try {
      const src = S.dirHandles.get(it.relDir);
      const dst = await trashDir(it.relDir, true);
      const pn = await moveFileNoClobber(src, it.plainName, dst, it.plainName);
      let sn;
      try {
        sn = await moveFileNoClobber(src, it.segName, dst, it.segName);
      } catch (e) {
        // roll the plain file back so the pair stays consistent
        try { await moveFile(dst, pn, src, it.plainName); } catch (e2) { /* leave as-is */ }
        throw e;
      }
      it.status = 'trash';
      it.trashNames = { plain: pn, seg: sn };
      S.trashLiveCount += 2;
      S.undoStack.push({ type: 'pair', i: idx });
      invalidateUrl(idx);
      refreshListRow(idx);
      updateStats();
      if (S.idx === idx) { // only auto-advance if the user hasn't navigated away meanwhile
        const j = nextActive(idx, +1);
        const k = j !== -1 ? j : nextActive(idx, -1);
        if (k !== -1) await showPair(k);
        else {
          loadToken++;
          $('#viewerEmpty').textContent = 'All pairs are in to_delete.';
          $('#viewerEmpty').hidden = false;
          renderPairInfo();
        }
      }
    } catch (e) {
      toast('Move failed: ' + e.message, 5000);
    } finally {
      S.busy = false;
      updateStats();
    }
  }

  async function trashAllUnpaired() {
    if (S.busy || S.exporting) return;
    const targets = S.unpaired.filter((u) => u.status === 'active');
    if (!targets.length) return;
    const ok = await confirmModal({
      title: 'Move unpaired files to to_delete?',
      bodyHTML: '<p>' + targets.length + ' file(s) without a matching partner will be moved to <code>to_delete</code>. You can undo this.</p>',
      okLabel: 'Move ' + targets.length + ' files',
    });
    if (!ok) return;
    S.busy = true;
    const moved = [];
    try {
      for (const u of targets) {
        const src = S.dirHandles.get(u.relDir);
        const dst = await trashDir(u.relDir, true);
        const dn = await moveFileNoClobber(src, u.name, dst, u.name);
        u.status = 'trash';
        u.trashName = dn;
        S.trashLiveCount++;
        moved.push(u);
      }
    } catch (e) {
      toast('Stopped: ' + e.message + ' (' + moved.length + ' moved)', 5000);
    } finally {
      if (moved.length) S.undoStack.push({ type: 'unpaired', entries: moved });
      S.busy = false;
      renderSidebar();
      updateStats();
      if (moved.length) toast(moved.length + ' unpaired file(s) → to_delete');
    }
  }

  // restore a trashed pair's files back to their source folder (with rollback on partial failure)
  async function restorePairFiles(it) {
    const src = await trashDir(it.relDir, false);
    const dst = S.dirHandles.get(it.relDir);
    const plainFinal = await moveFileNoClobber(src, it.trashNames.plain, dst, it.plainName);
    let segFinal;
    try {
      segFinal = await moveFileNoClobber(src, it.trashNames.seg, dst, it.segName);
    } catch (e) {
      // roll the plain restore back so disk still matches the 'trash' state
      try {
        await moveFile(dst, plainFinal, src, it.trashNames.plain);
      } catch (e2) {
        e.message += ' (rollback also failed — hit Rescan to resync)';
      }
      throw e;
    }
    if (plainFinal !== it.plainName || segFinal !== it.segName) {
      toast('Name was taken — restored as ' + plainFinal + ' / ' + segFinal, 4200);
    }
    it.plainName = plainFinal;
    it.segName = segFinal;
    it.status = 'active';
    it.trashNames = null;
    S.trashLiveCount -= 2;
  }

  async function restorePair(i) {
    if (S.busy || S.exporting) { toast('Busy…'); return; }
    const it = S.items[i];
    if (!it || it.status !== 'trash' || !it.trashNames) return;
    S.busy = true;
    try {
      await restorePairFiles(it);
      invalidateUrl(i);
      refreshListRow(i);
      if (S.idx === i) await showPair(i);
      toast('Restored pair #' + it.id);
    } catch (e) {
      toast('Restore failed: ' + e.message, 5000);
    } finally {
      S.busy = false;
      updateStats();
    }
  }

  async function undo() {
    if (S.busy || S.exporting) return;
    // skip entries already handled by a targeted restore
    let a = null;
    while (S.undoStack.length) {
      const top = S.undoStack[S.undoStack.length - 1];
      if (top.type === 'pair' && S.items[top.i] && S.items[top.i].status === 'trash') { a = top; break; }
      if (top.type === 'unpaired' && top.entries.some((u) => u.status === 'trash')) { a = top; break; }
      S.undoStack.pop();
    }
    if (!a) { toast('Nothing to undo'); updateStats(); return; }
    S.busy = true;
    try {
      if (a.type === 'pair') {
        const it = S.items[a.i];
        await restorePairFiles(it);   // throws on failure — entry stays on the stack for retry
        S.undoStack.pop();            // pop only after success
        invalidateUrl(a.i);
        refreshListRow(a.i);
        await showPair(a.i);
        toast('Restored pair #' + it.id);
      } else {
        const remaining = a.entries.filter((u) => u.status === 'trash');
        let n = 0;
        let failed = null;
        for (const u of remaining) {
          try {
            const src = await trashDir(u.relDir, false);
            const dst = S.dirHandles.get(u.relDir);
            const finalName = await moveFileNoClobber(src, u.trashName, dst, u.name);
            if (finalName !== u.name) u.name = finalName;
            u.status = 'active';
            u.trashName = null;
            S.trashLiveCount--;
            n++;
          } catch (e) {
            failed = e; // entry stays on the stack so Z can retry the rest
            break;
          }
        }
        renderSidebar();
        if (failed) toast('Restored ' + n + ', then stopped: ' + failed.message + ' — press Z to retry', 5000);
        else { S.undoStack.pop(); toast('Restored ' + n + ' unpaired file(s)'); }
      }
    } catch (e) {
      toast('Undo failed: ' + e.message + ' — press Z to retry', 5000);
    } finally {
      S.busy = false;
      updateStats();
    }
  }

  async function purgeTrash() {
    if (S.busy || S.exporting) return;
    if (!S.trashLiveCount) return;
    const ok = await confirmModal({
      title: 'Permanently delete ' + S.trashLiveCount + ' file(s)?',
      bodyHTML: '<p>Everything inside <code>' + esc(S.rootName) + '/to_delete</code> will be <b>permanently deleted</b>. This cannot be undone.</p>',
      okLabel: 'Delete permanently',
      danger: true,
    });
    if (!ok) return;
    S.busy = true;
    let failed = null;
    try {
      await S.root.removeEntry('to_delete', { recursive: true });
      toast('to_delete emptied');
    } catch (e) {
      failed = e;
    } finally {
      S.busy = false;
      if (failed) toast('Delete failed: ' + failed.message, 5000);
      await rescan();
    }
  }

  async function restoreAll() {
    if (S.busy || S.exporting) return;
    if (!S.trashLiveCount) return;
    const ok = await confirmModal({
      title: 'Restore everything from to_delete?',
      bodyHTML: '<p>' + S.trashLiveCount + ' file(s) will be moved back to their original folders.</p>',
      okLabel: 'Restore all',
    });
    if (!ok) return;
    S.busy = true;
    let n = 0;
    let failed = null;
    try {
      const td = await S.root.getDirectoryHandle('to_delete');
      const entries = [];
      for await (const f of walkFiles(td, '')) entries.push(f);
      for (const f of entries) {
        const dst = await getDirByRel(S.root, f.rel, true);
        await moveFileNoClobber(f.dir, f.name, dst, f.name);
        n++;
      }
      try { await S.root.removeEntry('to_delete', { recursive: true }); } catch (e) { /* non-fatal */ }
    } catch (e) {
      failed = e;
    } finally {
      S.busy = false;
      if (failed) toast('Restore stopped after ' + n + ': ' + failed.message, 5000);
      else toast('Restored ' + n + ' file(s)');
      await rescan();
    }
  }

  // ------------------------------------------------------------------ keyboard
  window.addEventListener('keydown', (e) => {
    if (S.currentTab !== 'review' || modalOpen()) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); return; }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    switch (e.key) {
      case 'ArrowLeft': e.preventDefault(); nav(-1); break;
      case 'ArrowRight': e.preventDefault(); nav(+1); break;
      case ' ': e.preventDefault(); toggleView(); break;
      case 'o': case 'O': e.preventDefault(); toggleOverlay(); break;
      case 'd': case 'D': case 'x': case 'X': case 'Delete': e.preventDefault(); markTrash(); break;
      case 'z': case 'Z': e.preventDefault(); undo(); break;
      case 'r': case 'R': {
        e.preventDefault();
        if (S.idx >= 0 && S.items[S.idx] && S.items[S.idx].status === 'trash') restorePair(S.idx);
        break;
      }
      case 'Home': { e.preventDefault(); const i = firstActive(); if (i !== -1) showPair(i); break; }
      case 'End': { e.preventDefault(); const i = lastActive(); if (i !== -1) showPair(i); break; }
    }
  });

  // ------------------------------------------------------------------ export tab
  function selectedCodec() {
    const el = $('.codec-card.sel');
    return C.CODECS.find((c) => c.id === (el ? el.dataset.id : 'prores-lt')) || C.CODECS[0];
  }
  function selectedFps() {
    return C.FPS_OPTIONS[Number($('#fpsSel').value) || 0];
  }

  function getExportFrames() {
    const frames = S.items
      .filter((x) => x.status === 'active')
      .map((x) => ({ relDir: x.relDir, name: x.plainName, id: x.id, ext: x.ext }));
    if ($('#chkUnpaired').checked) {
      for (const u of S.unpaired) {
        if (u.kind === 'plain' && u.status === 'active') {
          frames.push({ relDir: u.relDir, name: u.name, id: u.id, ext: u.ext });
        }
      }
    }
    return C.sortFrames(frames);
  }

  function refreshSource() {
    const el = $('#srcSummary');
    if (!S.root) {
      el.innerHTML = '<p>No frames loaded yet.</p><button class="btn primary" id="btnGoReview">Open a folder in Frame Review →</button>';
      const b = $('#btnGoReview');
      if (b) b.onclick = () => switchTab('review');
      $('#btnExport').disabled = true;
      updateNamePreview();
      return;
    }
    const frames = getExportFrames();
    const dirs = new Map();
    for (const f of frames) dirs.set(f.relDir, (dirs.get(f.relDir) || 0) + 1);
    const exts = [...new Set(frames.map((f) => f.ext))];
    let html = '<p><b>' + frames.length + '</b> frame(s) from <b>' + dirs.size + '</b> folder(s) — originals that survived review' +
      ($('#chkUnpaired').checked ? ' (incl. unpaired originals)' : '') + '.</p>';
    if (dirs.size) {
      html += '<details><summary>per-folder breakdown</summary><ul>' +
        [...dirs.entries()].map(([d, n]) => '<li><span class="mono">' + esc(d || '(root)') + '</span> — ' + n + '</li>').join('') +
        '</ul></details>';
    }
    if (exts.length > 1) {
      html += '<p class="warn-text">⚠ Mixed extensions (' + exts.join(', ') + ') — a single export needs one format. Export is blocked.</p>';
    }
    el.innerHTML = html;
    $('#btnExport').disabled = !frames.length || exts.length > 1 || S.exporting;
    updateNamePreview();
  }

  function updateNamePreview() {
    const codec = selectedCodec(), fps = selectedFps();
    const base = C.sanitizeName(S.rootName || 'frames') + '_' + codec.tag + '_' + fps.tag;
    $('#namePreview').textContent = base + '.' + codec.container;
  }

  function renderCodecCards() {
    $('#codecCards').innerHTML = C.CODECS.map((c) =>
      '<div class="codec-card' + (c.id === 'prores-lt' ? ' sel' : '') + '" data-id="' + c.id + '" tabindex="0" role="radio">' +
      '<div class="cc-head"><b>' + esc(c.label) + '</b>' +
      (c.badge ? '<span class="badge">' + esc(c.badge) + '</span>' : '') + '</div>' +
      '<p>' + esc(c.desc) + '</p>' +
      '<span class="dim small">.' + c.container + '</span></div>'
    ).join('');
    $$('.codec-card').forEach((card) => {
      const pick = () => {
        $$('.codec-card').forEach((x) => x.classList.remove('sel'));
        card.classList.add('sel');
        updateNamePreview();
      };
      card.addEventListener('click', pick);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    });
    $('#fpsSel').innerHTML = C.FPS_OPTIONS.map((f, i) => '<option value="' + i + '">' + esc(f.label) + '</option>').join('');
    $('#fpsSel').value = '0';
  }

  // ---- engine ----
  const CORE_CDNS = [
    'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd',
    'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd',
  ];

  function setEngineStatus(txt, cls) {
    const el = $('#engineStatus');
    el.textContent = txt;
    el.className = 'chip ' + (cls || '');
  }

  function onFFLog(ev) {
    const msg = ev && ev.message ? ev.message : String(ev);
    S.logRing.push(msg);
    if (S.logRing.length > 400) S.logRing.shift();
    if (S.probeSink) {
      const m = /^\s*V[A-Z.]{5}\s+(\S+)/.exec(msg); // encoder table line, e.g. " V....D prores_ks"
      if (m) S.probeSink.add(m[1]);
    }
    const n = C.parseFrameCount(msg);
    if (n !== null) {
      S.lastFrameSeen = n;
      if (S.encTotal) updateProgress(n, S.encTotal);
    }
  }

  async function detectVendorBase() {
    try {
      const r = await fetch('vendor/ffmpeg-core.wasm', { method: 'HEAD' });
      if (r.ok) return 'vendor';
    } catch (e) { /* no vendored copy */ }
    return null;
  }

  function loadEngine() {
    // memoize the in-flight promise so overlapping Preload/Export calls share one instance
    if (S.enginePromise) return S.enginePromise;
    $('#btnPreload').disabled = true;
    S.enginePromise = loadEngineInner().catch((e) => {
      S.enginePromise = null;
      $('#btnPreload').disabled = false;
      throw e;
    });
    return S.enginePromise;
  }

  async function loadEngineInner() {
    if (typeof FFmpegWASM === 'undefined' || typeof FFmpegUtil === 'undefined') {
      throw new Error('FFmpeg scripts did not load — lib/ffmpeg/ is missing or blocked.');
    }
    const { FFmpeg } = FFmpegWASM;
    const { toBlobURL } = FFmpegUtil;
    const ff = new FFmpeg();
    ff.on('log', onFFLog);
    setEngineStatus('Downloading FFmpeg core (~31 MB, first time only)…', 'warn');
    const bases = [];
    const vendor = await detectVendorBase();
    if (vendor) bases.push(vendor);
    bases.push(...CORE_CDNS);
    let loaded = false, lastErr = null;
    for (const base of bases) {
      try {
        await ff.load({
          coreURL: await toBlobURL(base + '/ffmpeg-core.js', 'text/javascript'),
          wasmURL: await toBlobURL(base + '/ffmpeg-core.wasm', 'application/wasm'),
        });
        loaded = true;
        break;
      } catch (e) { lastErr = e; }
    }
    if (!loaded) {
      setEngineStatus('Engine failed to load', 'bad');
      throw lastErr || new Error('could not load ffmpeg core');
    }
    S.ffmpeg = ff;
    S.ffReady = true;
    // probe encoders once (dedicated sink — the log ring is too small for the full table)
    if (!S.encoders) {
      S.probeSink = new Set();
      try {
        await ff.exec(['-hide_banner', '-encoders']);
        if (S.probeSink.size) S.encoders = S.probeSink;
      } catch (e) { /* probe is best-effort */ }
      S.probeSink = null;
      const chips = $('#encoderChips');
      if (S.encoders) {
        chips.innerHTML = ['prores_ks', 'libx264'].map((enc) =>
          '<span class="chip ' + (S.encoders.has(enc) ? 'ok' : 'bad') + '">' + enc + (S.encoders.has(enc) ? ' ✓' : ' ✗') + '</span>'
        ).join('');
      }
    }
    setEngineStatus('FFmpeg engine ready', 'ok');
    return ff;
  }

  function teardownEngine() {
    if (S.ffmpeg) {
      try { S.ffmpeg.terminate(); } catch (e) { /* already dead */ }
    }
    S.ffmpeg = null;
    S.ffReady = false;
    S.enginePromise = null;
    $('#btnPreload').disabled = S.exporting;
    setEngineStatus('Engine idle (loads on demand)', '');
  }

  // ---- progress / result UI ----
  function updateProgress(done, total) {
    const pct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
    $('#progBar').style.width = pct + '%';
    $('#progText').textContent = 'Encoding frame ' + done + ' / ' + total + '  (' + pct + '%)';
  }
  function setStage(txt) {
    $('#exportProgress').hidden = false;
    $('#progText').textContent = txt;
  }
  function showResult(html, cls) {
    const el = $('#exportResult');
    el.className = 'banner ' + cls;
    el.innerHTML = html;
    el.hidden = false;
  }
  function setExportLock(lock) {
    $('#btnOpen').disabled = lock || !window.showDirectoryPicker;
    $('#btnRescan').disabled = lock;
    $('#btnPreload').disabled = lock || !!S.enginePromise;
    $('#btnExport').disabled = lock;
    updateStats();
  }

  async function preflightDims(list, ext) {
    if (!['bmp', 'png', 'jpg', 'jpeg'].includes(ext)) return { ok: true, skipped: true, bad: [], unknown: [] };
    // JPEG metadata (ICC/XMP) can push the SOF marker deep into the file — take a generous slice
    const sliceLen = ext[0] === 'j' ? 2097152 : 8192;
    let ref = null;
    const bad = [], unknown = [];
    for (let i = 0; i < list.length; i++) {
      if (S.cancelFlag) throw canceledError();
      const f = list[i];
      const label = (f.relDir ? f.relDir + '/' : '') + f.name;
      try {
        const dh = S.dirHandles.get(f.relDir);
        const fh = await dh.getFileHandle(f.name);
        const file = await fh.getFile();
        const head = new Uint8Array(await file.slice(0, sliceLen).arrayBuffer());
        const s = C.imageSize(head, ext);
        if (!s) { unknown.push(label); continue; }
        if (!ref) ref = s;
        else if (s.w !== ref.w || s.h !== ref.h) bad.push({ name: label, why: s.w + '×' + s.h + ' ≠ ' + ref.w + '×' + ref.h });
      } catch (e) {
        if (e && e.canceled) throw e;
        unknown.push(label + ' (' + e.message + ')');
      }
      if (i % 40 === 0) setStage('Checking frame dimensions… ' + (i + 1) + ' / ' + list.length);
    }
    return { ok: bad.length === 0, ref, bad, unknown };
  }

  function requestNotifyPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }
  function notifyDone(body) {
    if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification('Fabinator WeakFrames', { body }); } catch (e) { /* ignore */ }
    }
    const old = 'Fabinator WeakFrames — Review & Export';
    document.title = '✅ Export complete — Fabinator WeakFrames';
    window.addEventListener('focus', () => { document.title = old; }, { once: true });
  }

  async function runExport() {
    if (S.exporting || S.busy || !S.root) return;
    $('#exportResult').hidden = true;

    const list = getExportFrames();
    if (!list.length) { showResult('No frames to export — review a folder first.', 'err'); return; }
    const exts = [...new Set(list.map((f) => f.ext))];
    if (exts.length > 1) {
      showResult('Export blocked: frames use mixed extensions (' + exts.join(', ') + '). One export = one image format.', 'err');
      return;
    }
    const ext = exts[0];
    const codec = selectedCodec();
    const fps = selectedFps();
    const baseName = C.sanitizeName(S.rootName) + '_' + codec.tag + '_' + fps.tag + '.' + codec.container;

    // lock BEFORE any await — a double-click must not start a second export
    S.exporting = true;
    S.cancelFlag = false;
    S.lastFrameSeen = 0;
    S.encTotal = 0;
    S.logRing = [];
    setExportLock(true);
    $('#btnCancel').hidden = false;
    $('#progBar').style.width = '0%';
    let saveHandle = null, savedInRoot = false, engineUsed = false;
    const t0 = performance.now();

    try {
      // pick destination first (needs the user-gesture)
      if (window.showSaveFilePicker) {
        try {
          saveHandle = await window.showSaveFilePicker({
            suggestedName: baseName,
            startIn: S.root,
            types: [{ description: codec.label, accept: { [codec.mime]: ['.' + codec.container] } }],
          });
        } catch (e) {
          if (e && e.name === 'AbortError') return; // user cancelled the dialog — quiet exit
          saveHandle = null;
        }
      }
      if (!saveHandle) {
        saveHandle = await S.root.getFileHandle(baseName, { create: true });
        savedInRoot = true;
      }

      requestNotifyPermission();

      setStage('Checking frame dimensions…');
      const pf = await preflightDims(list, ext);
      if (!pf.ok) {
        const lines = pf.bad.slice(0, 6).map((b) => '<li><span class="mono">' + esc(b.name) + '</span> — ' + esc(b.why) + '</li>').join('');
        throw new Error('__html__<b>Frames differ in size — export would require scaling, which this tool refuses to do.</b><ul>' + lines + '</ul>' +
          (pf.bad.length > 6 ? '<p>…and ' + (pf.bad.length - 6) + ' more.</p>' : ''));
      }

      setStage('Loading FFmpeg engine…');
      const ff = await loadEngine();
      engineUsed = true;
      if (S.cancelFlag) throw canceledError();
      if (S.encoders && !S.encoders.has(codec.encoder)) {
        throw new Error('This FFmpeg build has no ' + codec.encoder + ' encoder.');
      }

      setStage('Preparing ' + list.length + ' frames…');
      const files = [];
      for (let k = 0; k < list.length; k++) {
        if (S.cancelFlag) throw canceledError();
        const dh = S.dirHandles.get(list[k].relDir);
        const fh = await dh.getFileHandle(list[k].name);
        const f = await fh.getFile();
        files.push(new File([f], C.seqName(k, ext), { type: f.type }));
        if (k % 50 === 0) setStage('Preparing frames… ' + (k + 1) + ' / ' + list.length);
      }

      const outName = '/out.' + codec.container;
      const args = C.buildFFmpegArgs({ codecId: codec.id, fpsNum: fps.num, fpsDen: fps.den, ext, outName });

      try { await ff.createDir('/in'); } catch (e) { /* may already exist */ }
      await ff.mount('WORKERFS', { files }, '/in');

      S.encTotal = list.length;
      setStage('Encoding… (this runs locally in your browser; a few hundred frames can take a few minutes)');
      const ret = await ff.exec(args);
      if (S.cancelFlag) throw canceledError();
      if (ret !== 0) throw new Error('FFmpeg exited with code ' + ret);

      setStage('Writing file…');
      const data = await ff.readFile(outName);
      const w = await saveHandle.createWritable();
      await w.write(data);
      await w.close();

      const secs = ((performance.now() - t0) / 1000).toFixed(0);
      const verified = S.lastFrameSeen === list.length;
      const where = savedInRoot ? ' (saved into ' + esc(S.rootName) + '/ — save dialog unavailable)' : '';
      const unknownNote = (pf.unknown && pf.unknown.length)
        ? '<br><span class="dim small">' + pf.unknown.length + ' frame(s) had unparseable headers — dimension preflight skipped them.</span>' : '';
      // locate the export relative to the frames folder (browsers never expose absolute paths)
      let locLine = '';
      try {
        const rel = await S.root.resolve(saveHandle);
        locLine = (rel && rel.length)
          ? '<br>📂 Saved in <span class="mono">' + esc([S.rootName].concat(rel.slice(0, -1)).join(' / ') + ' /') + '</span> '
          : '<br>📂 Saved at the location you picked in the save dialog ';
      } catch (e) { locLine = '<br>'; }
      if (window.showOpenFilePicker) {
        locLine += '<button class="btn small-btn" id="btnReveal">📂 Open export folder…</button> ' +
          '<span class="dim small">(opens a file dialog at that location — web pages can\'t open Explorer directly)</span>';
      }
      showResult(
        '✅ <b>Export complete</b> — ' + list.length + ' frames → <span class="mono">' + esc(saveHandle.name) + '</span> (' +
        fmtBytes(data.byteLength) + ', ' + secs + 's)' + where + '<br>' +
        (verified
          ? '<span class="ok-text">Frame count verified: encoder reported ' + S.lastFrameSeen + ' / ' + list.length + ' — no duplication or dropping.</span>'
          : '<span class="warn-text">⚠ Encoder reported ' + S.lastFrameSeen + ' frames, expected ' + list.length + ' — inspect the file.</span>') +
        unknownNote + locLine,
        'ok');
      const rv = $('#btnReveal');
      if (rv) {
        rv.onclick = async () => {
          try {
            await window.showOpenFilePicker({ startIn: saveHandle }); // opens in the export file's folder
          } catch (e) { /* dialog dismissed — nothing to do */ }
        };
      }
      notifyDone(saveHandle.name + ' — ' + list.length + ' frames, ' + fmtBytes(data.byteLength));
    } catch (e) {
      if (e && (e.canceled || S.cancelFlag)) {
        showResult('Export canceled.', 'warn');
      } else if (e && e.message && e.message.startsWith('__html__')) {
        showResult(e.message.slice(8), 'err');
      } else {
        const tail = S.logRing.slice(-12).map(esc).join('\n');
        showResult('❌ Export failed: ' + esc(e && e.message ? e.message : String(e)) +
          (tail ? '<details><summary>FFmpeg log tail</summary><pre>' + tail + '</pre></details>' : ''), 'err');
      }
      // remove a half-written fallback file so no corrupt video is left behind
      if (savedInRoot && saveHandle) { try { await S.root.removeEntry(saveHandle.name); } catch (e2) { /* ignore */ } }
    } finally {
      S.exporting = false;
      S.encTotal = 0;
      $('#btnCancel').hidden = true;
      $('#exportProgress').hidden = true;
      if (engineUsed) teardownEngine(); // frees the wasm heap; core re-loads from browser cache next time
      setExportLock(false);
      refreshSource();
    }
  }

  function cancelExport() {
    if (!S.exporting) return;
    S.cancelFlag = true; // pre-encode loops poll this; terminate covers the encode itself
    try { if (S.ffmpeg) S.ffmpeg.terminate(); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------ init
  function init() {
    // tab wiring
    $$('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    $$('[data-goto]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.goto)));

    // review tab
    $('#btnOpen').addEventListener('click', openFolder);
    $('#btnRescan').addEventListener('click', rescan);
    $('#btnPrev').addEventListener('click', () => nav(-1));
    $('#btnNext').addEventListener('click', () => nav(+1));
    $('#btnToggle').addEventListener('click', toggleView);
    $('#btnOverlay').addEventListener('click', toggleOverlay);
    $('#ovlOpacity').addEventListener('input', applyView);
    $('#btnTrash').addEventListener('click', markTrash);
    $('#btnUndo').addEventListener('click', undo);
    $('#btnPurge').addEventListener('click', purgeTrash);
    $('#btnRestoreAll').addEventListener('click', restoreAll);
    $('#btnTrashUnpaired').addEventListener('click', trashAllUnpaired);
    $('#pairList').addEventListener('click', (e) => {
      const row = e.target.closest('.prow');
      if (row) showPair(Number(row.dataset.i));
    });

    // export tab
    renderCodecCards();
    $('#fpsSel').addEventListener('change', updateNamePreview);
    $('#chkUnpaired').addEventListener('change', refreshSource);
    $('#btnRefreshSrc').addEventListener('click', refreshSource);
    $('#btnExport').addEventListener('click', runExport);
    $('#btnCancel').addEventListener('click', cancelExport);
    $('#btnPreload').addEventListener('click', () => loadEngine().catch((e) => toast(e.message, 5000)));
    setEngineStatus('Engine idle (loads on demand)', '');

    // capability gate
    if (!window.showDirectoryPicker || !window.isSecureContext) {
      const b = $('#globalBanner');
      b.innerHTML = !window.isSecureContext
        ? '⚠ This page must be served over <b>https</b> or <b>localhost</b> for folder access to work.'
        : '⚠ This browser has no File System Access API. Use <b>Chrome</b> or <b>Edge</b> on desktop — Tab 2 and 3 need it.';
      b.hidden = false;
      $('#btnOpen').disabled = true;
    }

    refreshSource();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

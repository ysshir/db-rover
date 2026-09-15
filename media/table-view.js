// DB Rover テーブルビュー（ページング・ソート・編集・行削除）。
(function () {
  'use strict';

  var vscode = acquireVsCodeApi();
  var app = document.getElementById('app');

  var state = {
    schema: '',
    table: '',
    connectionName: '',
    columns: [],
    dbKind: 'postgres',
    where: '',
    editable: false,
    editableReason: '',
    pageSize: 200,
    offset: 0,
    limit: 200,
    totalCount: null,
    lastRowCount: 0,
    editCount: 0,
    deleteCount: 0,
  };

  app.innerHTML =
    '<div class="dbrover-toolbar">' +
    '<span class="dbrover-info dbrover-title"></span>' +
    '<select class="dbrover-select dbrover-pagesize">' +
    '<option value="100">100</option>' +
    '<option value="200">200</option>' +
    '<option value="500">500</option>' +
    '<option value="1000">1000</option>' +
    '</select>' +
    '<span class="dbrover-spacer"></span>' +
    '<span class="dbrover-info dbrover-editable-reason"></span>' +
    '<button class="dbrover-btn secondary dbrover-discard" disabled>変更を破棄</button>' +
    '<button class="dbrover-btn dbrover-save" disabled>変更を保存</button>' +
    '</div>' +
    '<div class="dbrover-where-bar">' +
    '<span class="dbrover-info">WHERE</span>' +
    '<div class="dbrover-where-input-wrap">' +
    '<input class="dbrover-input dbrover-where-input" type="text" spellcheck="false" autocomplete="off" ' +
    'placeholder="例: status = \'active\' AND created_at >= \'2024-01-01\'（Ctrl+Space で列名候補）" />' +
    '<div class="dbrover-suggest" style="display:none"></div>' +
    '</div>' +
    '<button class="dbrover-btn dbrover-where-apply">適用</button>' +
    '<button class="dbrover-btn secondary dbrover-where-clear">クリア</button>' +
    '</div>' +
    '<div class="dbrover-warning-bar" style="display:none"></div>' +
    '<div class="dbrover-grid-host" style="flex:1;min-height:0;display:flex;flex-direction:column"></div>' +
    '<div class="dbrover-toolbar dbrover-footer">' +
    '<button class="dbrover-btn secondary dbrover-first">先頭</button>' +
    '<button class="dbrover-btn secondary dbrover-prev">前</button>' +
    '<span class="dbrover-info dbrover-range"></span>' +
    '<button class="dbrover-btn secondary dbrover-next">次</button>' +
    '<button class="dbrover-btn secondary dbrover-last">末尾</button>' +
    '</div>';

  var titleEl = app.querySelector('.dbrover-title');
  var pageSizeEl = app.querySelector('.dbrover-pagesize');
  var editableReasonEl = app.querySelector('.dbrover-editable-reason');
  var discardBtn = app.querySelector('.dbrover-discard');
  var saveBtn = app.querySelector('.dbrover-save');
  var whereInput = app.querySelector('.dbrover-where-input');
  var whereApplyBtn = app.querySelector('.dbrover-where-apply');
  var whereClearBtn = app.querySelector('.dbrover-where-clear');
  var suggestEl = app.querySelector('.dbrover-suggest');
  var warningBar = app.querySelector('.dbrover-warning-bar');
  var gridHost = app.querySelector('.dbrover-grid-host');
  var firstBtn = app.querySelector('.dbrover-first');
  var prevBtn = app.querySelector('.dbrover-prev');
  var nextBtn = app.querySelector('.dbrover-next');
  var lastBtn = app.querySelector('.dbrover-last');
  var rangeEl = app.querySelector('.dbrover-range');

  var grid = null;

  function requestBrowse() {
    vscode.postMessage({
      type: 'browse',
      sort: grid ? grid.getSort() : [],
      where: state.where || undefined,
      offset: state.offset,
      limit: state.limit,
    });
  }

  function updateFooter() {
    var start = state.lastRowCount > 0 ? state.offset + 1 : 0;
    var end = state.offset + state.lastRowCount;
    var totalText = state.totalCount === null ? '全 ? 件' : '全 ' + state.totalCount + ' 件';
    rangeEl.textContent = start + ' - ' + end + ' 件 / ' + totalText;
    firstBtn.disabled = state.offset === 0;
    prevBtn.disabled = state.offset === 0;
    nextBtn.disabled =
      state.totalCount !== null ? state.offset + state.limit >= state.totalCount : state.lastRowCount < state.limit;
    lastBtn.disabled = state.totalCount === null;
  }

  function pendingTotal() {
    return state.editCount + state.deleteCount;
  }

  function updateSaveButtons() {
    var parts = [];
    if (state.editCount > 0) parts.push('更新 ' + state.editCount);
    if (state.deleteCount > 0) parts.push('削除 ' + state.deleteCount);
    saveBtn.disabled = pendingTotal() === 0;
    saveBtn.textContent = parts.length > 0 ? '変更を保存 (' + parts.join(' / ') + ')' : '変更を保存';
    discardBtn.disabled = pendingTotal() === 0;
  }

  function showWarning(message) {
    if (!message) {
      warningBar.style.display = 'none';
      return;
    }
    warningBar.textContent = message;
    warningBar.style.display = 'block';
  }

  // --- WHERE 式の入力と列名サジェスト ---

  var MAX_SUGGESTIONS = 50;
  var suggestState = { items: [], index: -1, token: null };

  function identifierQuote() {
    return state.dbKind === 'mysql' ? '`' : '"';
  }

  /** 引用符なしで書けない列名か。PostgreSQL は未引用だと小文字化されるため大文字を含むものも引用する。 */
  function needsQuoting(name) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return true;
    return state.dbKind === 'postgres' && /[A-Z]/.test(name);
  }

  function quoteIdentifier(name) {
    var q = identifierQuote();
    return q + String(name).split(q).join(q + q) + q;
  }

  /** キャレット直前の識別子らしき部分を切り出す。 */
  function currentToken() {
    var caret = whereInput.selectionStart === null ? whereInput.value.length : whereInput.selectionStart;
    var text = whereInput.value;
    var start = caret;
    while (start > 0 && /[A-Za-z0-9_$]/.test(text.charAt(start - 1))) {
      start -= 1;
    }
    return { start: start, end: caret, text: text.slice(start, caret) };
  }

  function matchingColumns(prefix) {
    if (!prefix) return state.columns.slice();
    var lower = prefix.toLowerCase();
    var startsWith = [];
    var contains = [];
    state.columns.forEach(function (col) {
      var name = col.name.toLowerCase();
      var at = name.indexOf(lower);
      if (at === 0) startsWith.push(col);
      else if (at > 0) contains.push(col);
    });
    return startsWith.concat(contains);
  }

  function hideSuggest() {
    suggestEl.style.display = 'none';
    suggestEl.innerHTML = '';
    suggestState = { items: [], index: -1, token: null };
  }

  function suggestVisible() {
    return suggestEl.style.display !== 'none';
  }

  function showSuggest(items, token) {
    if (items.length === 0) {
      hideSuggest();
      return;
    }
    suggestState.items = items.slice(0, MAX_SUGGESTIONS);
    suggestState.token = token;
    suggestState.index = 0;
    suggestEl.innerHTML = '';
    suggestState.items.forEach(function (col, index) {
      var row = document.createElement('div');
      row.className = 'dbrover-suggest-item' + (index === 0 ? ' active' : '');
      var name = document.createElement('span');
      name.className = 'dbrover-suggest-name';
      name.textContent = col.name;
      var meta = document.createElement('span');
      meta.className = 'dbrover-suggest-meta';
      meta.textContent = col.dataType + (col.isPrimaryKey ? ' / PK' : '') + (col.nullable ? '' : ' / NOT NULL');
      row.appendChild(name);
      row.appendChild(meta);
      row.addEventListener('mousedown', function (ev) {
        ev.preventDefault(); // 入力欄のフォーカスを保ったまま確定する
        applySuggestion(index);
      });
      suggestEl.appendChild(row);
    });
    suggestEl.style.display = '';
  }

  function moveSuggest(delta) {
    if (!suggestVisible()) return;
    var count = suggestState.items.length;
    suggestState.index = (suggestState.index + delta + count) % count;
    var rows = suggestEl.querySelectorAll('.dbrover-suggest-item');
    for (var i = 0; i < rows.length; i++) {
      if (i === suggestState.index) {
        rows[i].classList.add('active');
        rows[i].scrollIntoView({ block: 'nearest' });
      } else {
        rows[i].classList.remove('active');
      }
    }
  }

  function applySuggestion(index) {
    var col = suggestState.items[index];
    var token = suggestState.token;
    if (!col || !token) return;
    var inserted = needsQuoting(col.name) ? quoteIdentifier(col.name) : col.name;
    var text = whereInput.value;
    whereInput.value = text.slice(0, token.start) + inserted + text.slice(token.end);
    var caret = token.start + inserted.length;
    hideSuggest();
    whereInput.focus();
    whereInput.setSelectionRange(caret, caret);
  }

  function applyWhere() {
    hideSuggest();
    var next = whereInput.value.trim();
    state.where = next;
    whereInput.classList.toggle('is-active', next !== '');
    state.offset = 0;
    showWarning('');
    requestBrowse();
  }

  whereInput.addEventListener('input', function () {
    var token = currentToken();
    if (token.text) {
      showSuggest(matchingColumns(token.text), token);
    } else {
      hideSuggest();
    }
  });

  whereInput.addEventListener('keydown', function (ev) {
    if (suggestVisible()) {
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        moveSuggest(1);
        return;
      }
      if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        moveSuggest(-1);
        return;
      }
      if (ev.key === 'Enter' || ev.key === 'Tab') {
        ev.preventDefault();
        applySuggestion(suggestState.index);
        return;
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        hideSuggest();
        return;
      }
    }
    if (ev.key === ' ' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      var token = currentToken();
      showSuggest(matchingColumns(token.text), token);
      return;
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      applyWhere();
    }
  });

  whereInput.addEventListener('blur', function () {
    hideSuggest();
  });

  whereApplyBtn.addEventListener('click', applyWhere);

  whereClearBtn.addEventListener('click', function () {
    whereInput.value = '';
    applyWhere();
  });

  pageSizeEl.addEventListener('change', function () {
    state.limit = Number(pageSizeEl.value);
    state.offset = 0;
    requestBrowse();
  });

  discardBtn.addEventListener('click', function () {
    confirmDiscard();
  });

  firstBtn.addEventListener('click', function () {
    state.offset = 0;
    requestBrowse();
  });
  prevBtn.addEventListener('click', function () {
    state.offset = Math.max(0, state.offset - state.limit);
    requestBrowse();
  });
  nextBtn.addEventListener('click', function () {
    state.offset = state.offset + state.limit;
    requestBrowse();
  });
  lastBtn.addEventListener('click', function () {
    if (state.totalCount === null) return;
    var lastPageStart = Math.max(0, Math.floor((state.totalCount - 1) / state.limit) * state.limit);
    state.offset = lastPageStart;
    requestBrowse();
  });

  saveBtn.addEventListener('click', function () {
    requestSave();
  });

  /** 保存の入口。編集中のセルがあれば先に確定してから確認ダイアログを出す。 */
  function requestSave() {
    if (!grid || !state.editable) return;
    grid.commitActiveEditor();
    var mutations = buildMutations();
    if (mutations.length === 0) return;
    showSaveDialog(mutations);
  }

  function pkColumns() {
    return state.columns.filter(function (c) {
      return c.isPrimaryKey;
    });
  }

  function primaryKeyOf(rowIndex) {
    var original = grid.getRowOriginal(rowIndex);
    var key = {};
    pkColumns().forEach(function (pk) {
      var idx = state.columns.findIndex(function (c) {
        return c.name === pk.name;
      });
      key[pk.name] = original[idx];
    });
    return key;
  }

  function buildMutations() {
    var deleteRows = grid.getPendingDeleteRows();
    var mutations = [];

    var byRow = {};
    grid.getPendingEdits().forEach(function (edit) {
      if (!byRow[edit.rowIndex]) byRow[edit.rowIndex] = {};
      byRow[edit.rowIndex][edit.colName] = edit.value;
    });
    Object.keys(byRow).forEach(function (rowIndexStr) {
      var rowIndex = Number(rowIndexStr);
      mutations.push({ type: 'update', key: primaryKeyOf(rowIndex), changes: byRow[rowIndex] });
    });

    deleteRows.forEach(function (rowIndex) {
      mutations.push({ type: 'delete', key: primaryKeyOf(rowIndex) });
    });

    return mutations;
  }

  function sqlPreviewFor(mutation) {
    // ここでの SQL 表示はユーザー確認用の簡易プレビュー。
    // 実際の実行は拡張側で quoteIdent + プレースホルダによる安全な形で行われる。
    function quote(v) {
      if (v === null || v === undefined) return 'NULL';
      if (typeof v === 'number') return String(v);
      return "'" + String(v).replace(/'/g, "''") + "'";
    }
    function conditions(key) {
      return Object.keys(key)
        .map(function (col) {
          return '"' + col + '" = ' + quote(key[col]);
        })
        .join(' AND ');
    }
    if (mutation.type === 'delete') {
      return 'DELETE FROM "' + state.table + '" WHERE ' + conditions(mutation.key) + ';';
    }
    var setClause = Object.keys(mutation.changes)
      .map(function (col) {
        return '"' + col + '" = ' + quote(mutation.changes[col]);
      })
      .join(', ');
    return 'UPDATE "' + state.table + '" SET ' + setClause + ' WHERE ' + conditions(mutation.key) + ';';
  }

  /** 確認モーダル。body は DOM を組み立てて渡す。 */
  function showModal(options) {
    var backdrop = document.createElement('div');
    backdrop.className = 'dbrover-modal-backdrop';
    var modal = document.createElement('div');
    modal.className = 'dbrover-modal';
    modal.innerHTML =
      '<div class="dbrover-modal-header"></div>' +
      '<div class="dbrover-modal-body"></div>' +
      '<div class="dbrover-modal-footer">' +
      '<button class="dbrover-btn secondary dbrover-modal-cancel">キャンセル</button>' +
      '<button class="dbrover-btn dbrover-modal-run"></button>' +
      '</div>';
    modal.querySelector('.dbrover-modal-header').textContent = options.title;
    var body = modal.querySelector('.dbrover-modal-body');
    options.buildBody(body);
    var runBtn = modal.querySelector('.dbrover-modal-run');
    runBtn.textContent = options.confirmLabel;
    if (options.danger) runBtn.classList.add('danger');
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    var closing = false;
    function close() {
      if (closing) return;
      closing = true;
      document.removeEventListener('keydown', onKeydown, true);
      // 閉じるアニメーションが終わってから DOM を外す。アニメーションが
      // 無効（prefers-reduced-motion）な環境では animationend が来ないので
      // タイマーでも保険をかけ、どちらか早い方で消す。
      var removed = false;
      function removeNow() {
        if (removed) return;
        removed = true;
        backdrop.remove();
      }
      backdrop.addEventListener('animationend', removeNow);
      backdrop.classList.add('closing');
      setTimeout(removeNow, 200);
    }
    function onKeydown(ev) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        close();
      }
    }
    document.addEventListener('keydown', onKeydown, true);

    modal.querySelector('.dbrover-modal-cancel').addEventListener('click', close);
    runBtn.addEventListener('click', function () {
      close();
      options.onConfirm();
    });
    runBtn.focus();
  }

  function showSaveDialog(mutations) {
    showModal({
      title: '変更内容の確認 (' + mutations.length + ' 件)',
      confirmLabel: '実行',
      buildBody: function (body) {
        mutations.forEach(function (m) {
          var block = document.createElement('div');
          block.className = 'dbrover-sql-block' + (m.type === 'delete' ? ' danger' : '');
          block.textContent = sqlPreviewFor(m);
          body.appendChild(block);
        });
      },
      onConfirm: function () {
        vscode.postMessage({ type: 'applyEdits', mutations: mutations });
      },
    });
  }

  function confirmDiscard() {
    if (!grid || pendingTotal() === 0) return;
    var parts = [];
    if (state.editCount > 0) parts.push('セルの変更 ' + state.editCount + ' 件');
    if (state.deleteCount > 0) parts.push('削除候補 ' + state.deleteCount + ' 行');
    showModal({
      title: '変更を破棄しますか？',
      confirmLabel: '破棄する',
      danger: true,
      buildBody: function (body) {
        var text = document.createElement('div');
        text.textContent = parts.join(' と ') + ' を取り消します。この操作は元に戻せません。';
        body.appendChild(text);
      },
      onConfirm: function () {
        grid.clearPending();
      },
    });
  }

  function initGrid(payload) {
    state.schema = payload.schema;
    state.table = payload.table;
    state.connectionName = payload.connectionName;
    state.columns = payload.columns;
    state.dbKind = payload.dbKind || 'postgres';
    state.editable = payload.editable;
    state.editableReason = payload.editableReason || '';
    state.pageSize = payload.pageSize || 200;
    state.limit = state.pageSize;
    state.offset = 0;
    state.where = '';
    whereInput.value = '';
    whereInput.classList.remove('is-active');
    hideSuggest();

    titleEl.textContent = payload.table + ' (' + payload.connectionName + ')';
    pageSizeEl.value = String(state.pageSize);
    editableReasonEl.textContent = state.editable ? '' : state.editableReason;
    saveBtn.style.display = state.editable ? '' : 'none';
    discardBtn.style.display = state.editable ? '' : 'none';

    grid = window.DbRoverGrid.createGrid(gridHost, {
      editable: state.editable,
      initialLayout: payload.savedLayout,
      keymap: payload.keymap,
      onSortChange: function () {
        state.offset = 0;
        requestBrowse();
      },
      onLayoutChange: function (layout) {
        vscode.postMessage({ type: 'saveLayout', layout: layout });
      },
      onCopy: function (text) {
        vscode.postMessage({ type: 'copyValue', value: text });
      },
      onPendingChange: function (counts) {
        state.editCount = counts.editCount;
        state.deleteCount = counts.deleteCount;
        updateSaveButtons();
      },
    });
    grid.setColumns(state.columns);
    requestBrowse();
  }

  window.addEventListener('message', function (event) {
    var message = event.data;
    switch (message.type) {
      case 'init':
        initGrid(message.payload);
        break;
      case 'data':
        state.lastRowCount = message.result.rows.length;
        state.totalCount = message.result.totalCount;
        state.offset = message.result.offset;
        grid.setRows(message.result.rows);
        updateFooter();
        showWarning('');
        break;
      case 'requestSave':
        requestSave();
        break;
      case 'applied':
        showWarning('影響行数: ' + message.affectedRows);
        if (grid) grid.clearPending();
        requestBrowse();
        break;
      case 'error':
        showWarning('エラー: ' + message.message);
        break;
      default:
        console.warn('DB Rover: unknown message', message);
    }
  });

  vscode.postMessage({ type: 'ready' });
})();

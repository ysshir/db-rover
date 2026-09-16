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

  /**
   * ページャーのボタンに使う小さな図形。外部フォント（codicon）は読み込めないので、
   * currentColor で塗るインライン SVG にして配色をテーマに追従させる。
   */
  function iconSvg(paths) {
    return (
      '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true" focusable="false">' +
      paths +
      '</svg>'
    );
  }

  app.innerHTML =
    '<div class="dbrover-toolbar">' +
    '<span class="dbrover-info dbrover-title"></span>' +
    '<span class="dbrover-spacer"></span>' +
    '<span class="dbrover-info dbrover-editable-reason"></span>' +
    '<button class="dbrover-btn secondary dbrover-discard" disabled>変更を破棄</button>' +
    '<button class="dbrover-btn dbrover-save" disabled>変更を保存</button>' +
    '</div>' +
    '<div class="dbrover-where-bar">' +
    // ページャーは WHERE の左に置く。件数の変更・ページ送り・絞り込みは続けて触ることが
    // 多いので、グリッドの上下に離すより一列にまとめたほうが視線と手が動かない。
    '<div class="dbrover-pager">' +
    '<button class="dbrover-btn secondary dbrover-icon dbrover-first" title="先頭ページ" aria-label="先頭ページ">' +
    iconSvg('<path d="M3.5 3h1.6v10H3.5z"/><path d="M12.5 3.2v9.6L5.9 8z"/>') +
    '</button>' +
    '<button class="dbrover-btn secondary dbrover-icon dbrover-prev" title="前のページ" aria-label="前のページ">' +
    iconSvg('<path d="M10.8 3.2v9.6L4.2 8z"/>') +
    '</button>' +
    '<span class="dbrover-info dbrover-range"></span>' +
    '<button class="dbrover-btn secondary dbrover-icon dbrover-next" title="次のページ" aria-label="次のページ">' +
    iconSvg('<path d="M5.2 3.2v9.6L11.8 8z"/>') +
    '</button>' +
    '<button class="dbrover-btn secondary dbrover-icon dbrover-last" title="末尾ページ" aria-label="末尾ページ">' +
    iconSvg('<path d="M10.9 3h1.6v10h-1.6z"/><path d="M3.5 3.2v9.6L10.1 8z"/>') +
    '</button>' +
    '<select class="dbrover-select dbrover-pagesize" title="1 ページに読み込む件数" aria-label="1 ページに読み込む件数">' +
    '<option value="100">100 件</option>' +
    '<option value="200">200 件</option>' +
    '<option value="500">500 件</option>' +
    '<option value="1000">1000 件</option>' +
    '</select>' +
    '</div>' +
    '<span class="dbrover-info">WHERE</span>' +
    '<div class="dbrover-where-input-wrap">' +
    '<input class="dbrover-input dbrover-where-input" type="text" spellcheck="false" autocomplete="off" ' +
    'placeholder="例: status = \'active\' AND created_at >= \'2024-01-01\'（Enter で適用 / Ctrl+Space で列名候補）" />' +
    '<div class="dbrover-suggest" style="display:none"></div>' +
    '</div>' +
    '<button class="dbrover-btn secondary dbrover-where-clear" disabled>クリア</button>' +
    '</div>' +
    '<div class="dbrover-warning-bar" style="display:none"></div>' +
    '<div class="dbrover-grid-host" style="flex:1;min-height:0;display:flex;flex-direction:column"></div>';

  var titleEl = app.querySelector('.dbrover-title');
  var pageSizeEl = app.querySelector('.dbrover-pagesize');
  var editableReasonEl = app.querySelector('.dbrover-editable-reason');
  var discardBtn = app.querySelector('.dbrover-discard');
  var saveBtn = app.querySelector('.dbrover-save');
  var whereInput = app.querySelector('.dbrover-where-input');
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
    var totalText = state.totalCount === null ? '? 件' : state.totalCount + ' 件';
    rangeEl.textContent = start + '-' + end + ' / ' + totalText;
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

  // --- WHERE 式の入力と補完（列名と語句）---

  var MAX_SUGGESTIONS = 50;
  /** 語句の補完でキャレットから遡って見る単語数。"IS NOT NULL" を途中から拾うために要る。 */
  var MAX_PHRASE_WORDS = 3;
  var suggestState = { items: [], index: -1 };

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

  function normalizeSpaces(text) {
    return text.replace(/\s+/g, ' ');
  }

  /**
   * WHERE 式で使う語句の候補。`insert` が実際に入る文字列、`back` はキャレットを末尾から
   * 何文字戻すか（`IN ()` の括弧の中や `LIKE '%%'` の % の間に置くために使う）。
   *
   * 文の区切り（`;`）やコメントは WHERE 式の検証で弾かれるので、ここには入れないこと。
   */
  function keywordItems() {
    var items = [
      { label: 'IS NULL', insert: 'IS NULL', meta: '値が NULL' },
      { label: 'IS NOT NULL', insert: 'IS NOT NULL', meta: '値が NULL でない' },
      { label: 'AND', insert: 'AND ', meta: '条件を足す' },
      { label: 'OR', insert: 'OR ', meta: 'どちらかを満たす' },
      { label: 'NOT', insert: 'NOT ', meta: '条件を否定する' },
      { label: 'LIKE', insert: "LIKE '%%'", back: 2, meta: '部分一致（% は任意の文字列）' },
      { label: 'NOT LIKE', insert: "NOT LIKE '%%'", back: 2, meta: '部分一致の否定' },
      { label: 'IN', insert: 'IN ()', back: 1, meta: '並べたどれかに一致' },
      { label: 'NOT IN', insert: 'NOT IN ()', back: 1, meta: '並べたどれにも一致しない' },
      // "BETWEEN " の直後（末尾の " AND " 5 文字ぶん手前）にキャレットを置く
      { label: 'BETWEEN', insert: 'BETWEEN  AND ', back: 5, meta: '範囲（両端を含む）' },
      { label: 'IS TRUE', insert: 'IS TRUE', meta: '真' },
      { label: 'IS FALSE', insert: 'IS FALSE', meta: '偽' },
      { label: 'NULL', insert: 'NULL', meta: 'NULL リテラル' },
      { label: 'TRUE', insert: 'TRUE', meta: '真リテラル' },
      { label: 'FALSE', insert: 'FALSE', meta: '偽リテラル' },
      { label: 'CURRENT_DATE', insert: 'CURRENT_DATE', meta: '今日の日付' },
      { label: 'CURRENT_TIMESTAMP', insert: 'CURRENT_TIMESTAMP', meta: '現在日時' },
    ];
    if (state.dbKind === 'postgres') {
      items.push({ label: 'ILIKE', insert: "ILIKE '%%'", back: 2, meta: '大文字小文字を無視した部分一致' });
      items.push({ label: 'NOT ILIKE', insert: "NOT ILIKE '%%'", back: 2, meta: 'ILIKE の否定' });
      items.push({ label: 'SIMILAR TO', insert: "SIMILAR TO ''", back: 1, meta: 'パターンに一致' });
    }
    if (state.dbKind === 'mysql') {
      items.push({ label: 'REGEXP', insert: "REGEXP ''", back: 1, meta: '正規表現に一致' });
      items.push({ label: 'NOT REGEXP', insert: "NOT REGEXP ''", back: 1, meta: '正規表現に一致しない' });
    }
    if (state.dbKind === 'sqlite') {
      items.push({ label: 'GLOB', insert: "GLOB ''", back: 1, meta: 'ワイルドカード（* ?）で一致' });
    }
    return items.map(function (item) {
      item.kind = 'keyword';
      return item;
    });
  }

  function columnItems() {
    return state.columns.map(function (col) {
      return {
        kind: 'column',
        label: col.name,
        insert: needsQuoting(col.name) ? quoteIdentifier(col.name) : col.name,
        meta: col.dataType + (col.isPrimaryKey ? ' / PK' : '') + (col.nullable ? '' : ' / NOT NULL'),
      };
    });
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

  /**
   * キャレット直前を単語 1〜MAX_PHRASE_WORDS 個ぶんに切り出す（短いものから順）。
   * 空白で繋がった英字の並びだけを遡るので、`status = is` のように演算子を挟んだものは繋がらない。
   */
  function currentPhrases(token) {
    var text = whereInput.value;
    var phrases = [{ start: token.start, text: token.text }];
    var start = token.start;
    for (var i = 1; i < MAX_PHRASE_WORDS; i += 1) {
      var wordEnd = start;
      while (wordEnd > 0 && text.charAt(wordEnd - 1) === ' ') wordEnd -= 1;
      if (wordEnd === start) break; // 直前が空白でなければ語句として繋がらない
      var wordStart = wordEnd;
      while (wordStart > 0 && /[A-Za-z]/.test(text.charAt(wordStart - 1))) wordStart -= 1;
      if (wordStart === wordEnd) break;
      start = wordStart;
      phrases.push({ start: start, text: text.slice(start, token.end) });
    }
    return phrases;
  }

  /** それ自体で語句として完成しているか（"NOT" は完成、"IS" は未完成）。 */
  function isCompleteKeyword(text, keywords) {
    var word = normalizeSpaces(text).trim().toUpperCase();
    return keywords.some(function (item) {
      return item.label === word;
    });
  }

  /** 先頭が query に一致する語句だけを返す（打ち終わっているものは出さない）。 */
  function matchByPrefix(items, query) {
    var lower = normalizeSpaces(query).toLowerCase();
    if (lower === '') return [];
    return items.filter(function (item) {
      var label = item.label.toLowerCase();
      return label.length > lower.length && label.indexOf(lower) === 0;
    });
  }

  /** 前方一致を先に、途中一致を後に分けて返す。 */
  function rank(items, query) {
    var lower = query.toLowerCase();
    var prefix = [];
    var contains = [];
    items.forEach(function (item) {
      var at = item.label.toLowerCase().indexOf(lower);
      if (at === 0) prefix.push(item);
      else if (at > 0) contains.push(item);
    });
    return { prefix: prefix, contains: contains };
  }

  /** 直前の文脈から、列名が来る位置か（列名を語句より先に並べるか）を判断する。 */
  function expectsColumn(start) {
    var before = whereInput.value.slice(0, start).replace(/\s+$/, '');
    if (before === '') return true;
    if (/[(,]$/.test(before)) return true;
    return /\b(and|or|not)$/i.test(before);
  }

  /** 候補に「どこを置き換えるか」を持たせる。複数語の語句は前の単語ごと置き換える。 */
  function withRange(items, start, end) {
    return items.slice(0, MAX_SUGGESTIONS).map(function (item) {
      return {
        kind: item.kind,
        label: item.label,
        insert: item.insert,
        back: item.back || 0,
        meta: item.meta,
        start: start,
        end: end,
      };
    });
  }

  /**
   * キャレット位置に出す候補を集める。
   *
   * - 2 語以上に跨って語句に一致したときは、それだけを出す（"is not" の続きに列名は来ない）
   * - それ以外は列名と語句を混ぜ、直前の文脈から来そうな方を先に並べる
   */
  function collectSuggestions() {
    var token = currentToken();
    var keywords = keywordItems();

    // 単語を打ちかけている途中なら前の語まで遡る。空白の直後でも、直前の語が単体では
    // 完成していない（"is" のように続きがある）なら遡って "IS NULL" などを出す。
    // "NOT " のように単体で完成している語の後ろは列名が来る場所なので遡らない。
    var phrases = currentPhrases(token);
    if (token.text === '' && (phrases.length < 2 || isCompleteKeyword(phrases[1].text, keywords))) {
      phrases = [];
    }

    // 長い語句から順に見て、最初に当たったものを採用する
    for (var i = phrases.length - 1; i >= 1; i -= 1) {
      var matched = matchByPrefix(keywords, phrases[i].text);
      if (matched.length > 0) {
        return withRange(matched, phrases[i].start, token.end);
      }
    }

    var columns = columnItems();
    var columnHits = token.text ? rank(columns, token.text) : { prefix: columns, contains: [] };
    var keywordHits = token.text ? rank(keywords, token.text) : { prefix: keywords, contains: [] };
    var items = expectsColumn(token.start)
      ? columnHits.prefix.concat(keywordHits.prefix, columnHits.contains, keywordHits.contains)
      : keywordHits.prefix.concat(columnHits.prefix, keywordHits.contains, columnHits.contains);
    return withRange(items, token.start, token.end);
  }

  function hideSuggest() {
    suggestEl.style.display = 'none';
    suggestEl.innerHTML = '';
    suggestState = { items: [], index: -1 };
  }

  function suggestVisible() {
    return suggestEl.style.display !== 'none';
  }

  function showSuggest(items) {
    if (items.length === 0) {
      hideSuggest();
      return;
    }
    suggestState.items = items;
    suggestState.index = 0;
    suggestEl.innerHTML = '';
    suggestState.items.forEach(function (item, index) {
      var row = document.createElement('div');
      row.className = 'dbrover-suggest-item' + (index === 0 ? ' active' : '');
      var name = document.createElement('span');
      name.className = 'dbrover-suggest-name' + (item.kind === 'keyword' ? ' is-keyword' : '');
      name.textContent = item.label;
      var meta = document.createElement('span');
      meta.className = 'dbrover-suggest-meta';
      meta.textContent = item.meta;
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
    var item = suggestState.items[index];
    if (!item) return;
    var text = whereInput.value;
    whereInput.value = text.slice(0, item.start) + item.insert + text.slice(item.end);
    var caret = item.start + item.insert.length - item.back;
    hideSuggest();
    updateWhereButtons();
    whereInput.focus();
    whereInput.setSelectionRange(caret, caret);
  }

  function applyWhere() {
    hideSuggest();
    var next = whereInput.value.trim();
    state.where = next;
    whereInput.classList.toggle('is-active', next !== '');
    updateWhereButtons();
    state.offset = 0;
    showWarning('');
    requestBrowse();
  }

  /** クリアは消すものがあるときだけ押せるようにする（適用済みの WHERE か、入力中の文字）。 */
  function updateWhereButtons() {
    whereClearBtn.disabled = state.where === '' && whereInput.value.trim() === '';
  }

  whereInput.addEventListener('input', function () {
    updateWhereButtons();
    if (currentToken().text) {
      showSuggest(collectSuggestions());
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
      showSuggest(collectSuggestions());
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

  /**
   * 再読み込みの入口（Cmd/Ctrl+R）。ページ位置・ソート・WHERE はそのまま読み直す。
   * 未保存の変更は黙って捨てずに断る。
   */
  function reload() {
    if (pendingTotal() > 0) {
      showWarning('未保存の変更があるため再読み込みしませんでした。保存するか破棄してください。');
      return;
    }
    showWarning('');
    requestBrowse();
  }

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
    updateWhereButtons();
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
      case 'requestReload':
        reload();
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

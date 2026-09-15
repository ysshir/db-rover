// DB Rover 共通グリッド（仮想スクロール・ソート・フィルタ・列リサイズ/固定/非表示・セル編集）。
// フレームワーク不使用。webview 内でそのまま <script> 読み込みして使う。
(function (global) {
  'use strict';

  var ROW_HEIGHT = 24; // grid.css の --dbrover-row-height と一致させること
  var BUFFER_ROWS = 8;

  // --- キーバインド ---
  // 表記は "ctrl+shift+n" のように modifier を + で連ねる。"mod" は macOS で cmd、それ以外で ctrl。
  var IS_MAC = /Mac|iPhone|iPad|iPod/i.test(
    (global.navigator && (global.navigator.platform || global.navigator.userAgent)) || '',
  );

  var KEY_ALIASES = {
    esc: 'escape',
    del: 'delete',
    return: 'enter',
    up: 'arrowup',
    down: 'arrowdown',
    left: 'arrowleft',
    right: 'arrowright',
    space: ' ',
    plus: '+',
  };

  // 既定のキー割り当て。設定 dbRover.keybindings でアクション単位に上書きできる。
  var DEFAULT_KEYMAP = {
    edit: ['enter', 'f2'],
    moveUp: ['arrowup', 'ctrl+p'],
    moveDown: ['arrowdown', 'ctrl+n'],
    moveLeft: ['arrowleft', 'ctrl+b'],
    moveRight: ['arrowright', 'ctrl+f'],
    moveRowStart: ['home', 'ctrl+a'],
    moveRowEnd: ['end', 'ctrl+e'],
    moveTop: ['ctrl+home', 'mod+arrowup'],
    moveBottom: ['ctrl+end', 'mod+arrowdown'],
    pageUp: ['pageup'],
    pageDown: ['pagedown'],
    copy: ['mod+c'],
    setNull: ['alt+n'],
    deleteRow: ['ctrl+d', 'delete', 'backspace'],
  };

  function parseCombo(spec) {
    var combo = { ctrl: false, shift: false, alt: false, meta: false, key: '' };
    String(spec)
      .toLowerCase()
      .split('+')
      .forEach(function (rawPart) {
        var part = rawPart.trim();
        if (!part) return;
        if (part === 'ctrl' || part === 'control') combo.ctrl = true;
        else if (part === 'shift') combo.shift = true;
        else if (part === 'alt' || part === 'option') combo.alt = true;
        else if (part === 'cmd' || part === 'meta' || part === 'command') combo.meta = true;
        else if (part === 'mod' || part === 'cmdorctrl') {
          if (IS_MAC) combo.meta = true;
          else combo.ctrl = true;
        } else {
          combo.key = KEY_ALIASES[part] || part;
        }
      });
    return combo.key ? combo : null;
  }

  function eventKey(ev) {
    var key = ev.key;
    if (!key) return '';
    return key.toLowerCase();
  }

  /**
   * 押されたキーが combo のキーかどうか。macOS では Option 併用で ev.key が別の文字
   * （Option+N なら 'Dead'）になるため、英数字は物理キー（ev.code）でも照合する。
   */
  function keyMatches(combo, ev) {
    if (combo.key === eventKey(ev)) return true;
    var code = ev.code || '';
    if (/^[a-z]$/.test(combo.key)) return code === 'Key' + combo.key.toUpperCase();
    if (/^[0-9]$/.test(combo.key)) return code === 'Digit' + combo.key;
    return false;
  }

  function comboMatches(combo, ev) {
    return (
      combo.ctrl === ev.ctrlKey &&
      combo.shift === ev.shiftKey &&
      combo.alt === ev.altKey &&
      combo.meta === ev.metaKey &&
      keyMatches(combo, ev)
    );
  }

  var KEY_LABELS = {
    arrowup: '↑',
    arrowdown: '↓',
    arrowleft: '←',
    arrowright: '→',
    ' ': 'Space',
  };

  function formatCombo(combo) {
    var parts = [];
    if (combo.ctrl) parts.push(IS_MAC ? 'Control' : 'Ctrl');
    if (combo.alt) parts.push(IS_MAC ? 'Option' : 'Alt');
    if (combo.shift) parts.push('Shift');
    if (combo.meta) parts.push(IS_MAC ? 'Cmd' : 'Meta');
    var key = KEY_LABELS[combo.key] || combo.key.charAt(0).toUpperCase() + combo.key.slice(1);
    parts.push(key);
    return parts.join('+');
  }

  /** 既定のキーマップに overrides（アクション名 -> 文字列 or 文字列配列）を重ねる。 */
  function createKeymap(overrides) {
    var map = {};
    Object.keys(DEFAULT_KEYMAP).forEach(function (action) {
      map[action] = DEFAULT_KEYMAP[action]
        .map(parseCombo)
        .filter(Boolean);
    });
    if (overrides && typeof overrides === 'object') {
      Object.keys(overrides).forEach(function (action) {
        // 未知のアクション名は無視する（設定のタイプミスで既定が壊れないように）。
        if (!Object.prototype.hasOwnProperty.call(DEFAULT_KEYMAP, action)) return;
        var value = overrides[action];
        if (value === null || value === undefined) {
          map[action] = [];
          return;
        }
        var list = Array.isArray(value) ? value : [value];
        map[action] = list.map(parseCombo).filter(Boolean);
      });
    }
    return {
      /** 押されたキーに対応するアクション名。該当しなければ null。 */
      actionFor: function (ev) {
        var names = Object.keys(map);
        for (var i = 0; i < names.length; i++) {
          var combos = map[names[i]];
          for (var j = 0; j < combos.length; j++) {
            if (comboMatches(combos[j], ev)) return names[i];
          }
        }
        return null;
      },
      matches: function (action, ev) {
        var combos = map[action] || [];
        for (var i = 0; i < combos.length; i++) {
          if (comboMatches(combos[i], ev)) return true;
        }
        return false;
      },
      /** メニューに添えるための表記。割り当てが無ければ空文字。 */
      describe: function (action) {
        var combos = map[action] || [];
        return combos.length > 0 ? formatCombo(combos[0]) : '';
      },
    };
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isNumericType(dataType) {
    if (!dataType) return false;
    return /int|float|double|real|numeric|decimal|serial|money/i.test(dataType);
  }

  function formatDisplay(value) {
    if (value === null || value === undefined) {
      return { text: 'NULL', isNull: true };
    }
    return { text: String(value), isNull: false };
  }

  function createGrid(container, options) {
    options = options || {};
    var editable = !!options.editable;
    var onSortChange = options.onSortChange || function () {};
    var onLayoutChange = options.onLayoutChange || function () {};
    var onCopy = options.onCopy || function () {};

    var columns = []; // ColumnMeta[]
    var rows = []; // unknown[][]
    var sort = []; // {column, direction}[]
    var columnWidths = {};
    var pinnedCount = 0;
    var hiddenColumns = {};
    var pendingEdits = {}; // "rowIndex:colName" -> value (null 許容)
    var pendingDeletes = {}; // rowIndex -> true（保存時に DELETE する削除候補）
    var selected = null; // {rowIndex, colName}
    var activeEditor = null; // 編集中のセル。null なら編集モードではない
    var keymap = createKeymap(options.keymap);

    container.innerHTML =
      '<div class="dbrover-grid-container" tabindex="0">' +
      '<table class="dbrover-table">' +
      '<thead class="dbrover-thead"></thead>' +
      '<tbody></tbody>' +
      '</table>' +
      '</div>';

    var scrollEl = container.querySelector('.dbrover-grid-container');
    var theadEl = container.querySelector('thead');
    var tbodyEl = container.querySelector('tbody');

    function visibleColumns() {
      return columns.filter(function (c) {
        return !hiddenColumns[c.name];
      });
    }

    function columnIndexOf(colName) {
      return columns.findIndex(function (c) {
        return c.name === colName;
      });
    }

    function visibleIndexOf(colName) {
      return visibleColumns().findIndex(function (c) {
        return c.name === colName;
      });
    }

    function widthOf(name) {
      return columnWidths[name] || 140;
    }

    function buildLayout() {
      return {
        columnWidths: columnWidths,
        pinnedCount: pinnedCount,
        hiddenColumns: Object.keys(hiddenColumns).filter(function (k) {
          return hiddenColumns[k];
        }),
      };
    }

    function applyLayout(layout) {
      if (!layout) return;
      columnWidths = layout.columnWidths || {};
      pinnedCount = layout.pinnedCount || 0;
      hiddenColumns = {};
      (layout.hiddenColumns || []).forEach(function (name) {
        hiddenColumns[name] = true;
      });
    }

    /** 行番号列の幅。行数の桁数に合わせて広げる。 */
    function rownumWidth() {
      var digits = String(Math.max(rows.length, 1)).length;
      return Math.max(40, digits * 8 + 22);
    }

    /** 行番号セルを組み立てる。tag は 'th' か 'td'。 */
    function createRownumCell(tag, text) {
      var cell = document.createElement(tag);
      cell.className = 'dbrover-rownum';
      var width = rownumWidth();
      cell.style.width = width + 'px';
      cell.style.minWidth = width + 'px';
      cell.textContent = text;
      return cell;
    }

    // 固定列は行番号列の右隣から始まるので、その幅ぶんずらす。
    function leftOffsetFor(index, visCols) {
      var left = rownumWidth();
      for (var i = 0; i < index; i++) {
        left += widthOf(visCols[i].name);
      }
      return left;
    }

    function renderHeader() {
      var visCols = visibleColumns();
      var headRow = document.createElement('tr');
      headRow.appendChild(createRownumCell('th', '#'));
      visCols.forEach(function (col, index) {
        var th = document.createElement('th');
        th.className = 'dbrover-th';
        th.dataset.colName = col.name;
        th.style.width = widthOf(col.name) + 'px';
        th.style.minWidth = widthOf(col.name) + 'px';
        if (index < pinnedCount) {
          th.classList.add('pinned');
          th.style.left = leftOffsetFor(index, visCols) + 'px';
        }
        var sortIndex = sort.findIndex(function (s) {
          return s.column === col.name;
        });
        var arrow = '';
        var badge = '';
        if (sortIndex >= 0) {
          arrow = sort[sortIndex].direction === 'asc' ? ' ▲' : ' ▼';
          if (sort.length > 1) {
            badge = '<span class="dbrover-sort-badge">' + (sortIndex + 1) + '</span>';
          }
        }
        th.innerHTML =
          '<span class="dbrover-th-label"><span>' +
          escapeHtml(col.name) +
          arrow +
          '</span>' +
          badge +
          '</span><div class="dbrover-resizer"></div>';
        th.addEventListener('click', function (ev) {
          if (ev.target.classList.contains('dbrover-resizer')) return;
          toggleSort(col.name, ev.shiftKey);
        });
        th.addEventListener('contextmenu', function (ev) {
          ev.preventDefault();
          showColumnMenu(ev.clientX, ev.clientY, col, index);
        });
        var resizer = th.querySelector('.dbrover-resizer');
        resizer.addEventListener('mousedown', function (ev) {
          startResize(ev, col.name, th);
        });
        headRow.appendChild(th);
      });
      theadEl.innerHTML = '';
      theadEl.appendChild(headRow);

      applySelectionClasses();
    }

    function toggleSort(colName, additive) {
      var idx = sort.findIndex(function (s) {
        return s.column === colName;
      });
      if (!additive) {
        if (idx === 0 && sort.length === 1) {
          if (sort[0].direction === 'asc') {
            sort[0].direction = 'desc';
          } else {
            sort = [];
          }
        } else {
          sort = [{ column: colName, direction: 'asc' }];
        }
      } else {
        if (idx === -1) {
          sort.push({ column: colName, direction: 'asc' });
        } else if (sort[idx].direction === 'asc') {
          sort[idx].direction = 'desc';
        } else {
          sort.splice(idx, 1);
        }
      }
      renderHeader();
      onSortChange(sort.slice());
    }

    var resizeState = null;
    function startResize(ev, colName, th) {
      ev.preventDefault();
      ev.stopPropagation();
      resizeState = { colName: colName, startX: ev.clientX, startWidth: widthOf(colName) };
      document.addEventListener('mousemove', onResizeMove);
      document.addEventListener('mouseup', onResizeUp);
    }
    function onResizeMove(ev) {
      if (!resizeState) return;
      var delta = ev.clientX - resizeState.startX;
      var newWidth = Math.max(40, resizeState.startWidth + delta);
      columnWidths[resizeState.colName] = newWidth;
      renderHeader();
      renderBody();
    }
    function onResizeUp() {
      document.removeEventListener('mousemove', onResizeMove);
      document.removeEventListener('mouseup', onResizeUp);
      resizeState = null;
      onLayoutChange(buildLayout());
    }

    var menuEl = null;
    function closeContextMenu() {
      if (menuEl) {
        menuEl.remove();
        menuEl = null;
      }
    }
    /** 指定位置にメニューを開く。build には項目追加用の item(label, handler, disabled) が渡る。 */
    function openMenu(x, y, build) {
      closeContextMenu();
      menuEl = document.createElement('div');
      menuEl.className = 'dbrover-context-menu';
      menuEl.style.left = x + 'px';
      menuEl.style.top = y + 'px';

      function item(label, handler, disabled) {
        var div = document.createElement('div');
        div.className = 'dbrover-context-menu-item' + (disabled ? ' disabled' : '');
        div.textContent = label;
        if (!disabled) {
          div.addEventListener('click', function () {
            handler();
            closeContextMenu();
          });
        }
        menuEl.appendChild(div);
      }

      build(item);

      document.body.appendChild(menuEl);
      setTimeout(function () {
        document.addEventListener('click', closeContextMenu, { once: true });
      }, 0);
    }

    /** セルを右クリックしたときのメニュー（値のコピー・NULL 設定・行の削除候補）。 */
    function showCellMenu(x, y, rowIndex, col) {
      selectCell(rowIndex, col.name);
      openMenu(x, y, function (item) {
        item('値をコピー (' + keymap.describe('copy') + ')', copySelected);
        if (!editable) return;
        var isDeleting = !!pendingDeletes[rowIndex];
        item('NULL に設定 (' + keymap.describe('setNull') + ')', setNullOnSelected, isDeleting);
        item(
          (isDeleting ? 'この行の削除候補を解除' : 'この行を削除候補にする') +
            ' (' +
            keymap.describe('deleteRow') +
            ')',
          toggleDeleteSelectedRow,
        );
      });
    }

    function showColumnMenu(x, y, col, visIndex) {
      openMenu(x, y, function (item) {
        item('この列までを固定', function () {
          pinnedCount = visIndex + 1;
          renderAll();
          onLayoutChange(buildLayout());
        });
        item('固定を解除', function () {
          pinnedCount = 0;
          renderAll();
          onLayoutChange(buildLayout());
        });
        item('この列を非表示', function () {
          hiddenColumns[col.name] = true;
          renderAll();
          onLayoutChange(buildLayout());
        });
        item('すべての列を表示', function () {
          hiddenColumns = {};
          renderAll();
          onLayoutChange(buildLayout());
        });
      });
    }

    var pendingScrollFrame = null;
    scrollEl.addEventListener('scroll', function () {
      if (pendingScrollFrame) return;
      pendingScrollFrame = requestAnimationFrame(function () {
        pendingScrollFrame = null;
        renderBody();
      });
    });

    function pendingKey(rowIndex, colName) {
      return rowIndex + ':' + colName;
    }

    function cellValue(rowIndex, colName, colIndex) {
      var key = pendingKey(rowIndex, colName);
      if (Object.prototype.hasOwnProperty.call(pendingEdits, key)) {
        return pendingEdits[key];
      }
      return rows[rowIndex][colIndex];
    }

    function renderBody() {
      var visCols = visibleColumns();
      var colIndexByName = {};
      columns.forEach(function (c, i) {
        colIndexByName[c.name] = i;
      });

      var total = rows.length;
      var viewportHeight = scrollEl.clientHeight || 400;
      var scrollTop = scrollEl.scrollTop;
      var startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_ROWS);
      var visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + BUFFER_ROWS * 2;
      var endIndex = Math.min(total, startIndex + visibleCount);

      tbodyEl.innerHTML = '';
      activeEditor = null; // 描き直したので編集中の input は失われている

      if (startIndex > 0) {
        var topSpacer = document.createElement('tr');
        var topTd = document.createElement('td');
        topTd.colSpan = visCols.length + 1;
        topTd.style.height = startIndex * ROW_HEIGHT + 'px';
        topTd.style.padding = '0';
        topTd.style.border = 'none';
        topSpacer.appendChild(topTd);
        tbodyEl.appendChild(topSpacer);
      }

      for (var r = startIndex; r < endIndex; r++) {
        var tr = document.createElement('tr');
        tr.className = 'dbrover-row';
        tr.style.height = ROW_HEIGHT + 'px';
        tr.dataset.rowIndex = String(r);
        if (pendingDeletes[r]) tr.classList.add('pending-delete');
        var rownumCell = createRownumCell('td', String(r + 1));
        rownumCell.dataset.rowIndex = String(r);
        tr.appendChild(rownumCell);
        visCols.forEach(function (col, visIdx) {
          // r は var 宣言のためループ終了後には endIndex になる。ハンドラ用にこの反復の値を捕捉する。
          var rowIndex = r;
          var colIndex = colIndexByName[col.name];
          var raw = cellValue(rowIndex, col.name, colIndex);
          var display = formatDisplay(raw);
          var td = document.createElement('td');
          td.className = 'dbrover-td';
          if (isNumericType(col.dataType)) td.classList.add('numeric');
          if (display.isNull) td.classList.add('null-value');
          var isPending = Object.prototype.hasOwnProperty.call(pendingEdits, pendingKey(rowIndex, col.name));
          if (isPending) td.classList.add('pending-edit');
          if (visIdx < pinnedCount) {
            td.classList.add('pinned');
            td.style.left = leftOffsetFor(visIdx, visCols) + 'px';
          }
          td.style.width = widthOf(col.name) + 'px';
          td.textContent = display.text;
          td.dataset.rowIndex = String(rowIndex);
          td.dataset.colName = col.name;
          // 1 回目のクリックは選択、選択済みセルをもう一度クリックすると編集モードに入る。
          td.addEventListener('click', function () {
            var isSelected = selected && selected.rowIndex === rowIndex && selected.colName === col.name;
            if (isSelected && editable && !pendingDeletes[rowIndex]) {
              beginEdit(td, rowIndex, col, colIndex);
            } else {
              selectCell(rowIndex, col.name);
            }
          });
          td.addEventListener('contextmenu', function (ev) {
            ev.preventDefault();
            showCellMenu(ev.clientX, ev.clientY, rowIndex, col);
          });
          if (editable) {
            td.addEventListener('dblclick', function () {
              if (pendingDeletes[rowIndex]) return;
              selectCell(rowIndex, col.name);
              beginEdit(td, rowIndex, col, colIndex);
            });
          }
          tr.appendChild(td);
        });
        tbodyEl.appendChild(tr);
      }

      if (endIndex < total) {
        var bottomSpacer = document.createElement('tr');
        var bottomTd = document.createElement('td');
        bottomTd.colSpan = visCols.length + 1;
        bottomTd.style.height = (total - endIndex) * ROW_HEIGHT + 'px';
        bottomTd.style.padding = '0';
        bottomTd.style.border = 'none';
        bottomSpacer.appendChild(bottomTd);
        tbodyEl.appendChild(bottomSpacer);
      }

      applySelectionClasses();
    }

    /** 選択セル・選択行・選択列のクラスだけを付け替える（表の作り直しを伴わない）。 */
    function applySelectionClasses() {
      var selectedCol = selected ? selected.colName : null;
      var selectedRow = selected ? String(selected.rowIndex) : null;
      var ths = theadEl.querySelectorAll('th');
      for (var i = 0; i < ths.length; i++) {
        ths[i].classList.toggle('column-selected', !!selectedCol && ths[i].dataset.colName === selectedCol);
      }
      var tds = tbodyEl.querySelectorAll('td.dbrover-td');
      for (var j = 0; j < tds.length; j++) {
        var td = tds[j];
        var sameCol = !!selectedCol && td.dataset.colName === selectedCol;
        var sameRow = selectedRow !== null && td.dataset.rowIndex === selectedRow;
        td.classList.toggle('column-selected', sameCol);
        td.classList.toggle('row-selected', sameRow);
        td.classList.toggle('selected', sameCol && sameRow);
      }
      var rownums = tbodyEl.querySelectorAll('td.dbrover-rownum');
      for (var k = 0; k < rownums.length; k++) {
        rownums[k].classList.toggle('row-selected', selectedRow !== null && rownums[k].dataset.rowIndex === selectedRow);
      }
    }

    /** 行が仮想スクロールの外にあれば見える位置までスクロールする。 */
    function ensureVisible(rowIndex, visIndex) {
      var headerHeight = theadEl.offsetHeight || 0;
      var viewHeight = scrollEl.clientHeight - headerHeight;
      var top = rowIndex * ROW_HEIGHT;
      if (viewHeight > 0) {
        if (top < scrollEl.scrollTop) {
          scrollEl.scrollTop = top;
        } else if (top + ROW_HEIGHT > scrollEl.scrollTop + viewHeight) {
          scrollEl.scrollTop = top + ROW_HEIGHT - viewHeight;
        }
      }
      var visCols = visibleColumns();
      if (visIndex >= pinnedCount && visIndex < visCols.length) {
        var left = leftOffsetFor(visIndex, visCols);
        var width = widthOf(visCols[visIndex].name);
        // 固定列の下に隠れないよう、固定列の合計幅ぶん手前で止める。
        var frozenWidth = leftOffsetFor(Math.min(pinnedCount, visCols.length), visCols);
        if (left - frozenWidth < scrollEl.scrollLeft) {
          scrollEl.scrollLeft = Math.max(0, left - frozenWidth);
        } else if (left + width > scrollEl.scrollLeft + scrollEl.clientWidth) {
          scrollEl.scrollLeft = left + width - scrollEl.clientWidth;
        }
      }
    }

    function rowsPerPage() {
      var headerHeight = theadEl.offsetHeight || 0;
      return Math.max(1, Math.floor((scrollEl.clientHeight - headerHeight) / ROW_HEIGHT) - 1);
    }

    /** 表示中の列インデックス基準でセルを選択し、必要ならスクロールする。 */
    function moveTo(rowIndex, visIndex) {
      var visCols = visibleColumns();
      if (visCols.length === 0 || rows.length === 0) return;
      var r = Math.max(0, Math.min(rows.length - 1, rowIndex));
      var ci = Math.max(0, Math.min(visCols.length - 1, visIndex));
      var col = visCols[ci];
      selected = { rowIndex: r, colName: col.name };
      ensureVisible(r, ci);
      renderBody();
    }

    function moveBy(rowDelta, colDelta) {
      if (!selected) {
        moveTo(0, 0);
        return;
      }
      moveTo(selected.rowIndex + rowDelta, visibleIndexOf(selected.colName) + colDelta);
    }

    function selectCell(rowIndex, colName) {
      selected = { rowIndex: rowIndex, colName: colName };
      applySelectionClasses();
    }

    function findCellElement(rowIndex, colName) {
      return tbodyEl.querySelector(
        'td[data-row-index="' + rowIndex + '"][data-col-name="' + cssEscape(colName) + '"]',
      );
    }

    /** 1 セルだけ表示を描き直す。表全体を再描画しないので、進行中のクリック操作を壊さない。 */
    function paintCell(td, rowIndex, col, colIndex) {
      var display = formatDisplay(cellValue(rowIndex, col.name, colIndex));
      td.innerHTML = '';
      td.style.padding = '';
      td.textContent = display.text;
      td.classList.toggle('null-value', display.isNull);
      td.classList.toggle(
        'pending-edit',
        Object.prototype.hasOwnProperty.call(pendingEdits, pendingKey(rowIndex, col.name)),
      );
    }

    /** 選択中のセルで編集モードに入る（キー操作用）。 */
    function beginEditSelected() {
      if (!editable || !selected) return;
      if (pendingDeletes[selected.rowIndex]) return;
      var colIndex = columnIndexOf(selected.colName);
      if (colIndex < 0) return;
      var td = findCellElement(selected.rowIndex, selected.colName);
      if (td) beginEdit(td, selected.rowIndex, columns[colIndex], colIndex);
    }

    function beginEdit(td, rowIndex, col, colIndex) {
      if (!editable) return;
      if (td.querySelector('.dbrover-cell-editor')) return; // すでに編集中
      var currentValue = cellValue(rowIndex, col.name, colIndex);
      var input = document.createElement('input');
      input.className = 'dbrover-cell-editor';
      input.type = 'text';
      input.value = currentValue === null || currentValue === undefined ? '' : String(currentValue);
      td.textContent = '';
      td.style.padding = '0';
      td.appendChild(input);
      input.focus();
      input.select();

      var editor = {
        rowIndex: rowIndex,
        colName: col.name,
        done: false,
        /** 値を確定して編集モードを抜ける。再描画は呼び出し側に任せる。 */
        commit: function (value) {
          if (editor.done) return;
          editor.done = true;
          if (activeEditor === editor) activeEditor = null;
          applyEdit(rowIndex, col.name, value);
        },
        /** 変更を捨てて編集モードを抜ける。 */
        cancel: function () {
          if (editor.done) return;
          editor.done = true;
          if (activeEditor === editor) activeEditor = null;
          paintCell(td, rowIndex, col, colIndex);
          focusGrid();
        },
      };
      activeEditor = editor;

      // NULL に設定: 既定は Ctrl/Cmd+Shift+Delete。空文字にしたいだけなら単に空のまま確定する。
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          editor.commit(input.value);
          moveBy(1, 0);
          focusGrid();
        } else if (ev.key === 'Tab') {
          ev.preventDefault();
          editor.commit(input.value);
          moveBy(0, ev.shiftKey ? -1 : 1);
          focusGrid();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          editor.cancel();
        } else if (keymap.matches('setNull', ev)) {
          ev.preventDefault();
          editor.commit(null);
          renderBody();
          focusGrid();
        }
      });
      input.addEventListener('blur', function () {
        if (editor.done) return;
        // 別のセルをクリックしたときに表全体を作り直すと、そのクリックが行き場を失う。
        // ここでは編集中のセルだけ元の表示に戻す。
        editor.commit(input.value);
        paintCell(td, rowIndex, col, colIndex);
      });
    }

    function focusGrid() {
      scrollEl.focus({ preventScroll: true });
    }

    /** 保留編集の状態だけを更新する。描画は呼び出し側に任せる。 */
    function applyEdit(rowIndex, colName, value) {
      var key = pendingKey(rowIndex, colName);
      var colIndex = columnIndexOf(colName);
      var original = rows[rowIndex][colIndex];
      var newValue = value;
      var originalAsText = original === null || original === undefined ? null : String(original);
      if (newValue === originalAsText) {
        delete pendingEdits[key];
      } else {
        pendingEdits[key] = newValue;
      }
      notifyPending();
    }

    function setNullOnSelected() {
      if (!editable || !selected) return;
      if (pendingDeletes[selected.rowIndex]) return;
      applyEdit(selected.rowIndex, selected.colName, null);
      renderBody();
    }

    /** 選択行の削除候補フラグを反転する。保存するまでは DB に触らない。 */
    function toggleDeleteSelectedRow() {
      if (!editable || !selected) return;
      var rowIndex = selected.rowIndex;
      if (pendingDeletes[rowIndex]) {
        delete pendingDeletes[rowIndex];
      } else {
        pendingDeletes[rowIndex] = true;
        // 削除する行のセル編集は無意味なので取り消す。
        Object.keys(pendingEdits).forEach(function (key) {
          if (Number(key.slice(0, key.indexOf(':'))) === rowIndex) {
            delete pendingEdits[key];
          }
        });
      }
      renderBody();
      notifyPending();
    }

    function notifyPending() {
      if (typeof options.onPendingChange === 'function') {
        options.onPendingChange({
          editCount: Object.keys(pendingEdits).length,
          deleteCount: Object.keys(pendingDeletes).length,
        });
      }
    }

    function copySelected() {
      if (!selected) return;
      var colIndex = columnIndexOf(selected.colName);
      var value = cellValue(selected.rowIndex, selected.colName, colIndex);
      onCopy(value === null || value === undefined ? '' : String(value));
    }

    scrollEl.addEventListener('keydown', function (ev) {
      if (activeEditor) return; // 編集中のキーは input 側のハンドラで処理する
      // ESC は選択解除に使い、ここで止める。素通しすると VS Code 側にフォーカスが
      // 移ってしまい、表全体が枠線で囲まれたように見える。
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        if (selected) {
          selected = null;
          applySelectionClasses();
        }
        return;
      }
      var action = keymap.actionFor(ev);
      if (!action) return;
      var visCols = visibleColumns();
      switch (action) {
        case 'moveUp':
          moveBy(-1, 0);
          break;
        case 'moveDown':
          moveBy(1, 0);
          break;
        case 'moveLeft':
          moveBy(0, -1);
          break;
        case 'moveRight':
          moveBy(0, 1);
          break;
        case 'moveRowStart':
          moveTo(selected ? selected.rowIndex : 0, 0);
          break;
        case 'moveRowEnd':
          moveTo(selected ? selected.rowIndex : 0, visCols.length - 1);
          break;
        case 'moveTop':
          moveTo(0, selected ? visibleIndexOf(selected.colName) : 0);
          break;
        case 'moveBottom':
          moveTo(rows.length - 1, selected ? visibleIndexOf(selected.colName) : 0);
          break;
        case 'pageUp':
          moveBy(-rowsPerPage(), 0);
          break;
        case 'pageDown':
          moveBy(rowsPerPage(), 0);
          break;
        case 'edit':
          beginEditSelected();
          break;
        case 'copy':
          copySelected();
          break;
        case 'setNull':
          setNullOnSelected();
          break;
        case 'deleteRow':
          toggleDeleteSelectedRow();
          break;
        default:
          return;
      }
      ev.preventDefault();
    });

    function cssEscape(value) {
      return String(value).replace(/["\\]/g, '\\$&');
    }

    function renderAll() {
      renderHeader();
      renderBody();
    }

    return {
      setColumns: function (cols) {
        columns = cols;
        var initialLayout = options.initialLayout;
        if (initialLayout) {
          applyLayout(initialLayout);
          options.initialLayout = null;
        }
        columns.forEach(function (c) {
          if (!columnWidths[c.name]) {
            columnWidths[c.name] = 140;
          }
        });
        renderAll();
      },
      setRows: function (newRows) {
        rows = newRows;
        pendingEdits = {};
        pendingDeletes = {};
        selected = null;
        activeEditor = null;
        scrollEl.scrollTop = 0;
        // 行数が変わると行番号列の幅も変わるため、ヘッダーごと引き直す。
        renderAll();
        notifyPending();
        // どこにもフォーカスが無いときだけグリッドに寄せる（WHERE 入力中に奪わないため）。
        if (document.activeElement === document.body) {
          focusGrid();
        }
      },
      setSort: function (newSort) {
        sort = newSort || [];
        renderHeader();
      },
      getSort: function () {
        return sort.slice();
      },
      getLayout: buildLayout,
      applyLayout: function (layout) {
        applyLayout(layout);
        renderAll();
      },
      getPendingEdits: function () {
        var result = [];
        Object.keys(pendingEdits).forEach(function (key) {
          var sep = key.indexOf(':');
          var rowIndex = Number(key.slice(0, sep));
          var colName = key.slice(sep + 1);
          result.push({ rowIndex: rowIndex, colName: colName, value: pendingEdits[key] });
        });
        return result;
      },
      getPendingDeleteRows: function () {
        return Object.keys(pendingDeletes).map(Number);
      },
      /** 編集中のセルがあれば値を確定する（保存の直前に呼ぶ）。 */
      commitActiveEditor: function () {
        if (!activeEditor) return;
        var input = tbodyEl.querySelector('.dbrover-cell-editor');
        activeEditor.commit(input ? input.value : '');
        renderBody();
      },
      /** 保留中の編集と削除候補をすべて取り消す。 */
      clearPending: function () {
        pendingEdits = {};
        pendingDeletes = {};
        renderBody();
        notifyPending();
      },
      getRowOriginal: function (rowIndex) {
        return rows[rowIndex];
      },
      setNullOnSelected: setNullOnSelected,
      toggleDeleteSelectedRow: toggleDeleteSelectedRow,
      hasSelection: function () {
        return !!selected;
      },
      focus: focusGrid,
      getColumns: function () {
        return columns;
      },
    };
  }

  global.DbRoverGrid = {
    createGrid: createGrid,
    createKeymap: createKeymap,
    DEFAULT_KEYMAP: DEFAULT_KEYMAP,
    ROW_HEIGHT: ROW_HEIGHT,
    escapeHtml: escapeHtml,
  };
})(window);

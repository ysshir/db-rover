// DB Rover クエリ結果パネル（読み取り専用グリッド + CSV 出力）。
// `;` で分割した複数の SQL 文をまとめて受け取り、結果セレクタで切り替えて表示する。
(function () {
  'use strict';

  var vscode = acquireVsCodeApi();
  var app = document.getElementById('app');

  app.innerHTML =
    '<div class="dbrover-toolbar">' +
    '<select class="dbrover-select dbrover-statement-select" style="display:none"></select>' +
    '<span class="dbrover-info dbrover-summary"></span>' +
    '<span class="dbrover-spacer"></span>' +
    '<button class="dbrover-btn secondary dbrover-copy-csv">CSV をコピー</button>' +
    '<button class="dbrover-btn secondary dbrover-save-csv">CSV として保存</button>' +
    '</div>' +
    '<div class="dbrover-overall-summary" style="display:none"></div>' +
    '<div class="dbrover-warning-bar" style="display:none"></div>' +
    '<details class="dbrover-details-collapsible">' +
    '<summary>実行した SQL</summary>' +
    '<div class="dbrover-sql-block dbrover-sql-text"></div>' +
    '</details>' +
    '<div class="dbrover-command-message" style="display:none;padding:8px"></div>' +
    '<div class="dbrover-error-message" style="display:none"></div>' +
    '<div class="dbrover-skipped-message" style="display:none">エラーのため実行されませんでした</div>' +
    '<div class="dbrover-grid-host" style="flex:1;min-height:0;display:flex;flex-direction:column"></div>';

  var statementSelect = app.querySelector('.dbrover-statement-select');
  var overallSummaryEl = app.querySelector('.dbrover-overall-summary');
  var summaryEl = app.querySelector('.dbrover-summary');
  var warningBar = app.querySelector('.dbrover-warning-bar');
  var sqlTextEl = app.querySelector('.dbrover-sql-text');
  var commandMessageEl = app.querySelector('.dbrover-command-message');
  var errorMessageEl = app.querySelector('.dbrover-error-message');
  var skippedMessageEl = app.querySelector('.dbrover-skipped-message');
  var gridHost = app.querySelector('.dbrover-grid-host');
  var copyCsvBtn = app.querySelector('.dbrover-copy-csv');
  var saveCsvBtn = app.querySelector('.dbrover-save-csv');

  var keymap = {}; // 拡張側から config で届くキー割り当ての上書き
  var grid = null;
  var outcomes = []; // 直近に受け取った StatementOutcome[]
  var selectedIndex = 0;

  /** グリッドはキー割り当てを受け取ってから作る（生成後は差し替えない）。 */
  function ensureGrid() {
    if (!grid) {
      grid = window.DbRoverGrid.createGrid(gridHost, {
        editable: false,
        keymap: keymap,
        onCopy: function (text) {
          vscode.postMessage({ type: 'copyValue', value: text });
        },
      });
    }
    return grid;
  }

  copyCsvBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'exportCsv', mode: 'copy', index: selectedIndex });
  });
  saveCsvBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'exportCsv', mode: 'save', index: selectedIndex });
  });
  statementSelect.addEventListener('change', function () {
    selectedIndex = Number(statementSelect.value);
    renderSelected();
  });

  /** SQL の先頭を 1 行・30 文字程度に畳んでラベルにする。 */
  function summarizeSql(sql) {
    var flattened = sql.replace(/\s+/g, ' ').trim();
    if (flattened.length > 30) {
      return flattened.slice(0, 30) + '…';
    }
    return flattened;
  }

  /** エラーがあれば最初のエラー項目、無ければ最後の成功項目を初期選択する。 */
  function pickInitialIndex(list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].status === 'error') {
        return i;
      }
    }
    for (var j = list.length - 1; j >= 0; j--) {
      if (list[j].status === 'ok') {
        return j;
      }
    }
    return 0;
  }

  function renderStatementSelect() {
    if (outcomes.length < 2) {
      statementSelect.style.display = 'none';
      statementSelect.innerHTML = '';
      return;
    }
    statementSelect.style.display = '';
    statementSelect.innerHTML = outcomes
      .map(function (outcome) {
        var statusLabel = outcome.status === 'error' ? '[エラー] ' : outcome.status === 'skipped' ? '[未実行] ' : '';
        var label = outcome.index + 1 + '. ' + statusLabel + summarizeSql(outcome.sql);
        return '<option value="' + outcome.index + '">' + escapeHtml(label) + '</option>';
      })
      .join('');
    statementSelect.value = String(selectedIndex);
  }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function renderOverallSummary() {
    if (outcomes.length < 2) {
      overallSummaryEl.style.display = 'none';
      return;
    }
    var okCount = outcomes.filter(function (o) {
      return o.status === 'ok';
    }).length;
    var errorCount = outcomes.filter(function (o) {
      return o.status === 'error';
    }).length;
    var skippedCount = outcomes.filter(function (o) {
      return o.status === 'skipped';
    }).length;
    var parts = [outcomes.length + ' 文を実行（成功 ' + okCount + ' / エラー ' + errorCount];
    if (skippedCount > 0) {
      parts[0] += ' / 未実行 ' + skippedCount;
    }
    parts[0] += '）';
    overallSummaryEl.textContent = parts.join('');
    overallSummaryEl.style.display = 'block';
    overallSummaryEl.className = 'dbrover-overall-summary' + (errorCount > 0 ? ' has-error' : '');
  }

  function renderSelected() {
    var outcome = outcomes[selectedIndex];
    if (!outcome) {
      return;
    }

    statementSelect.className =
      'dbrover-select dbrover-statement-select status-' + outcome.status;

    sqlTextEl.textContent = outcome.sql;

    warningBar.style.display = 'none';
    commandMessageEl.style.display = 'none';
    errorMessageEl.style.display = 'none';
    skippedMessageEl.style.display = 'none';
    gridHost.style.display = 'none';

    if (outcome.status === 'error') {
      errorMessageEl.style.display = 'block';
      errorMessageEl.textContent = outcome.message || 'エラーが発生しました。';
      summaryEl.textContent = '';
      copyCsvBtn.disabled = true;
      saveCsvBtn.disabled = true;
      return;
    }

    if (outcome.status === 'skipped') {
      skippedMessageEl.style.display = 'block';
      summaryEl.textContent = '';
      copyCsvBtn.disabled = true;
      saveCsvBtn.disabled = true;
      return;
    }

    var result = outcome.result;
    if (!result) {
      copyCsvBtn.disabled = true;
      saveCsvBtn.disabled = true;
      return;
    }

    var hasColumns = result.columns.length > 0;
    gridHost.style.display = hasColumns ? 'flex' : 'none';
    commandMessageEl.style.display = hasColumns ? 'none' : 'block';
    commandMessageEl.textContent = result.command || '';

    var summaryParts = [];
    summaryParts.push('実行時間: ' + result.durationMs + ' ms');
    summaryParts.push('行数: ' + result.rowCount);
    summaryEl.textContent = summaryParts.join(' / ');

    if (result.truncated) {
      warningBar.style.display = 'block';
      warningBar.textContent = '結果は行数制限により打ち切られました（表示中: ' + result.rowCount + ' 行）。';
    }

    if (hasColumns) {
      var columns = result.columns.map(function (name) {
        return { name: name, dataType: '', nullable: true, isPrimaryKey: false };
      });
      ensureGrid().setColumns(columns);
      grid.setRows(result.rows);
    }

    var enableCsv = hasColumns && result.rows.length > 0;
    copyCsvBtn.disabled = !enableCsv;
    saveCsvBtn.disabled = !enableCsv;
  }

  function renderResults(connectionName, newOutcomes) {
    outcomes = newOutcomes || [];
    selectedIndex = pickInitialIndex(outcomes);
    renderStatementSelect();
    renderOverallSummary();
    renderSelected();
  }

  window.addEventListener('message', function (event) {
    var message = event.data;
    switch (message.type) {
      case 'config':
        keymap = message.keymap || {};
        break;
      case 'results':
        renderResults(message.connectionName, message.outcomes);
        break;
      case 'error':
        warningBar.style.display = 'block';
        warningBar.textContent = 'エラー: ' + message.message;
        break;
      default:
        console.warn('DB Rover: unknown message', message);
    }
  });

  vscode.postMessage({ type: 'ready' });
})();

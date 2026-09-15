// DB Rover 接続情報の入力・編集モーダル。
(function () {
  'use strict';

  var vscode = acquireVsCodeApi();
  var app = document.getElementById('app');

  var DEFAULT_PORTS = { postgres: 5432, mysql: 3306 };

  var state = {
    mode: 'create',
    id: undefined,
    hasStoredPassword: false,
    busy: false,
  };

  app.innerHTML =
    '<div class="dbrover-modal-backdrop">' +
    '<div class="dbrover-modal dbrover-editor">' +
    '<div class="dbrover-modal-header dbrover-editor-title">接続を追加</div>' +
    '<div class="dbrover-modal-body">' +
    '<div class="dbrover-form">' +
    '<div class="dbrover-form-row">' +
    '<label class="dbrover-form-label" for="f-name">表示名</label>' +
    '<input id="f-name" class="dbrover-input dbrover-f-name" type="text" placeholder="My Database" />' +
    '</div>' +
    '<div class="dbrover-form-row">' +
    '<label class="dbrover-form-label" for="f-kind">種類</label>' +
    '<select id="f-kind" class="dbrover-select dbrover-f-kind">' +
    '<option value="postgres">PostgreSQL</option>' +
    '<option value="mysql">MySQL / MariaDB</option>' +
    '<option value="sqlite">SQLite</option>' +
    '</select>' +
    '</div>' +
    '<div class="dbrover-server-fields">' +
    '<div class="dbrover-form-row">' +
    '<label class="dbrover-form-label" for="f-host">ホスト名</label>' +
    '<input id="f-host" class="dbrover-input dbrover-f-host" type="text" placeholder="localhost" />' +
    '</div>' +
    '<div class="dbrover-form-row">' +
    '<label class="dbrover-form-label" for="f-port">ポート番号</label>' +
    '<input id="f-port" class="dbrover-input dbrover-f-port" type="text" inputmode="numeric" />' +
    '</div>' +
    '<div class="dbrover-form-row">' +
    '<label class="dbrover-form-label" for="f-database">データベース名</label>' +
    '<input id="f-database" class="dbrover-input dbrover-f-database" type="text" placeholder="（省略可）" />' +
    '</div>' +
    '<div class="dbrover-form-row">' +
    '<label class="dbrover-form-label" for="f-user">ユーザー名</label>' +
    '<input id="f-user" class="dbrover-input dbrover-f-user" type="text" placeholder="（省略可）" />' +
    '</div>' +
    '<div class="dbrover-form-row">' +
    '<label class="dbrover-form-label" for="f-password">パスワード</label>' +
    '<div class="dbrover-form-control">' +
    '<input id="f-password" class="dbrover-input dbrover-f-password" type="password" />' +
    '<div class="dbrover-form-hint dbrover-password-hint">SecretStorage に保存され、設定ファイルには書き込まれません。</div>' +
    '<label class="dbrover-checkbox dbrover-clear-password-row" style="display:none">' +
    '<input type="checkbox" class="dbrover-f-clear-password" />' +
    '<span>保存済みのパスワードを削除する</span>' +
    '</label>' +
    '</div>' +
    '</div>' +
    '<div class="dbrover-form-row">' +
    '<span class="dbrover-form-label">SSL</span>' +
    '<label class="dbrover-checkbox">' +
    '<input type="checkbox" class="dbrover-f-ssl" />' +
    '<span>SSL 接続を使用する</span>' +
    '</label>' +
    '</div>' +
    '</div>' +
    '<div class="dbrover-sqlite-fields" style="display:none">' +
    '<div class="dbrover-form-row">' +
    '<label class="dbrover-form-label" for="f-file">ファイル</label>' +
    '<div class="dbrover-form-control dbrover-file-control">' +
    '<input id="f-file" class="dbrover-input dbrover-f-file" type="text" placeholder="./data/app.sqlite" />' +
    '<button class="dbrover-btn secondary dbrover-browse">参照…</button>' +
    '</div>' +
    '</div>' +
    '<div class="dbrover-form-hint">ワークスペース相対パス・絶対パス・~ 展開に対応しています。</div>' +
    '</div>' +
    '</div>' +
    '<div class="dbrover-editor-status" style="display:none"></div>' +
    '</div>' +
    '<div class="dbrover-modal-footer">' +
    '<button class="dbrover-btn secondary dbrover-test">接続テスト</button>' +
    '<span class="dbrover-spacer"></span>' +
    '<button class="dbrover-btn secondary dbrover-cancel">キャンセル</button>' +
    '<button class="dbrover-btn dbrover-save">保存</button>' +
    '</div>' +
    '</div>' +
    '</div>';

  var titleEl = app.querySelector('.dbrover-editor-title');
  var nameEl = app.querySelector('.dbrover-f-name');
  var kindEl = app.querySelector('.dbrover-f-kind');
  var hostEl = app.querySelector('.dbrover-f-host');
  var portEl = app.querySelector('.dbrover-f-port');
  var databaseEl = app.querySelector('.dbrover-f-database');
  var userEl = app.querySelector('.dbrover-f-user');
  var passwordEl = app.querySelector('.dbrover-f-password');
  var passwordHintEl = app.querySelector('.dbrover-password-hint');
  var clearPasswordRow = app.querySelector('.dbrover-clear-password-row');
  var clearPasswordEl = app.querySelector('.dbrover-f-clear-password');
  var sslEl = app.querySelector('.dbrover-f-ssl');
  var fileEl = app.querySelector('.dbrover-f-file');
  var serverFields = app.querySelector('.dbrover-server-fields');
  var sqliteFields = app.querySelector('.dbrover-sqlite-fields');
  var statusEl = app.querySelector('.dbrover-editor-status');
  var browseBtn = app.querySelector('.dbrover-browse');
  var testBtn = app.querySelector('.dbrover-test');
  var cancelBtn = app.querySelector('.dbrover-cancel');
  var saveBtn = app.querySelector('.dbrover-save');

  function setStatus(level, message) {
    if (!message) {
      statusEl.style.display = 'none';
      statusEl.textContent = '';
      return;
    }
    statusEl.style.display = '';
    statusEl.textContent = message;
    statusEl.className = 'dbrover-editor-status ' + (level === 'error' ? 'is-error' : 'is-info');
  }

  function setBusy(busy) {
    state.busy = busy;
    testBtn.disabled = busy;
    saveBtn.disabled = busy;
    browseBtn.disabled = busy;
  }

  function applyKind() {
    var kind = kindEl.value;
    var isSqlite = kind === 'sqlite';
    serverFields.style.display = isSqlite ? 'none' : '';
    sqliteFields.style.display = isSqlite ? '' : 'none';
    testBtn.style.display = '';
  }

  /** 種類を切り替えたとき、ポートが空か他方の既定値のままなら既定値に追従させる。 */
  function syncDefaultPort(previousKind) {
    var kind = kindEl.value;
    if (kind === 'sqlite') return;
    var current = portEl.value.trim();
    var previousDefault = DEFAULT_PORTS[previousKind];
    if (current === '' || (previousDefault !== undefined && current === String(previousDefault))) {
      portEl.value = String(DEFAULT_PORTS[kind]);
    }
  }

  function usesStoredPassword() {
    return state.hasStoredPassword && !clearPasswordEl.checked && passwordEl.value === '';
  }

  function collect() {
    var kind = kindEl.value;
    var draft = { id: state.id, name: nameEl.value, kind: kind };
    if (kind === 'sqlite') {
      draft.file = fileEl.value;
      return draft;
    }
    draft.host = hostEl.value;
    var portText = portEl.value.trim();
    draft.port = portText === '' ? undefined : Number(portText);
    draft.database = databaseEl.value;
    draft.user = userEl.value;
    draft.ssl = sslEl.checked;
    return draft;
  }

  /** 送信前のクライアント側検証。問題があればメッセージを返す。 */
  function validationError(draft) {
    if (!draft.name.trim()) return '表示名を入力してください。';
    if (draft.kind === 'sqlite') {
      return draft.file.trim() ? undefined : 'SQLite のデータベースファイルを指定してください。';
    }
    if (!draft.host.trim()) return 'ホスト名を入力してください。';
    var portText = portEl.value.trim();
    if (portText !== '' && !/^\d+$/.test(portText)) return 'ポート番号は数値で入力してください。';
    if (draft.port !== undefined && (draft.port < 1 || draft.port > 65535)) {
      return 'ポート番号は 1〜65535 の範囲で入力してください。';
    }
    return undefined;
  }

  function submit(kindOfAction) {
    if (state.busy) return;
    var draft = collect();
    var error = validationError(draft);
    if (error) {
      setStatus('error', error);
      return;
    }
    setStatus(null, '');
    if (kindOfAction === 'test') {
      setStatus('info', '接続を確認しています…');
      vscode.postMessage({
        type: 'test',
        connection: draft,
        password: passwordEl.value || undefined,
        useStoredPassword: usesStoredPassword(),
      });
      return;
    }
    vscode.postMessage({
      type: 'save',
      connection: draft,
      password: passwordEl.value || undefined,
      clearPassword: clearPasswordEl.checked,
    });
  }

  kindEl.addEventListener('change', (function () {
    var previousKind = kindEl.value;
    return function () {
      syncDefaultPort(previousKind);
      previousKind = kindEl.value;
      applyKind();
    };
  })());

  clearPasswordEl.addEventListener('change', function () {
    passwordEl.disabled = clearPasswordEl.checked;
    if (clearPasswordEl.checked) {
      passwordEl.value = '';
    }
  });

  browseBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'browseFile' });
  });
  testBtn.addEventListener('click', function () {
    submit('test');
  });
  saveBtn.addEventListener('click', function () {
    submit('save');
  });
  cancelBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'cancel' });
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      vscode.postMessage({ type: 'cancel' });
      return;
    }
    if (event.key === 'Enter' && (event.target === null || event.target.tagName !== 'BUTTON')) {
      event.preventDefault();
      submit('save');
    }
  });

  window.addEventListener('message', function (event) {
    var message = event.data;
    switch (message.type) {
      case 'init': {
        var payload = message.payload;
        var connection = payload.connection;
        state.mode = payload.mode;
        state.id = connection.id;
        state.hasStoredPassword = payload.hasStoredPassword;

        titleEl.textContent = payload.mode === 'edit' ? '接続を編集' : '接続を追加';
        saveBtn.textContent = payload.mode === 'edit' ? '更新' : '保存';
        nameEl.value = connection.name || '';
        kindEl.value = connection.kind || 'postgres';
        hostEl.value = connection.host || '';
        portEl.value = connection.port === undefined || connection.port === null ? '' : String(connection.port);
        databaseEl.value = connection.database || '';
        userEl.value = connection.user || '';
        sslEl.checked = connection.ssl === true;
        fileEl.value = connection.file || '';
        passwordEl.value = '';
        passwordEl.disabled = false;
        clearPasswordEl.checked = false;
        clearPasswordRow.style.display = payload.hasStoredPassword ? '' : 'none';
        passwordHintEl.textContent = payload.hasStoredPassword
          ? 'パスワードは保存済みです。変更する場合のみ入力してください。'
          : 'SecretStorage に保存され、設定ファイルには書き込まれません。';
        if (portEl.value === '' && kindEl.value !== 'sqlite') {
          portEl.value = String(DEFAULT_PORTS[kindEl.value]);
        }
        applyKind();
        setStatus(null, '');
        setBusy(false);
        nameEl.focus();
        nameEl.select();
        break;
      }
      case 'file':
        fileEl.value = message.path;
        break;
      case 'busy':
        setBusy(message.busy);
        break;
      case 'status':
        setStatus(message.level, message.message);
        break;
      default:
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();

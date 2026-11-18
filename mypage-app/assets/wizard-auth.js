/* ============================================================
   AMP. 予約ウィザード — マイページ登録（認証）モジュール
   ------------------------------------------------------------
   役割:
   - ステップ1で選ばれた登録方法（パスキー / Facebook）を受け取り、
     自前API（Cloudflare Worker）で登録を開始する。
   - config.js の API_BASE が未設定の間は「選択のみ」モードで即座に
     成功を返し、現行ウィザードの動作（トグル選択）を一切変えない。
   - パスキー登録には氏名＋メールが必要なため、その場で小さな
     モーダルを開いて受け取る（パスワードは作らない）。
   - Facebook（OAuth）は画面遷移を伴うため、遷移前に予約ドラフトを
     sessionStorage に保存し、戻ってきたら復元できるようにする。
     ただし config.js の FACEBOOK_APP_ID が未設定の間は遷移させない
     （未設定の Worker は /auth/facebook/start で 503 を返し、エラー
     画面に取り残されるため）。その場合は mode:"facebook-unavailable"
     を返し、呼び出し側が「準備中」の案内を出す。
   - 両方選ばれた場合はパスキーを先に完了させ、モーダル内から
     続けて Facebook 連携へ進めるようにする（連携はマイページでも可）。
     Facebook 未設定時は連携ボタンを出さず、準備中の旨をモーダル内に
     表示してパスキー登録だけを完了させる。
   - 戻り値には methods（{passkey, facebook} の登録済み状態）を含め、
     呼び出し側がステップ1の「登録済み」表示とステップ5の確認欄
     （cf-reg）へ反映できるようにする。嘘の成功は返さない：実際に
     サーバーで確認できた状態だけを true にする。

   組み込み方法は docs/wizard-integration.md を参照。
   index.html 側の既存関数（toggleReg / goStep2）は変更せず、
   goStep2 の成功直後に onStep1Continue(booking) を呼ぶ形で接続する。
   依存：config.js → auth-client.js → wizard-auth.js の順に読み込む。
   ============================================================ */
window.AmpAuth = (function () {
  "use strict";

  var C = window.AmpAuthClient;
  var DRAFT_KEY = "amp_booking_draft";

  function configured() {
    return typeof window.AMP_AUTH_CONFIGURED === "function" && window.AMP_AUTH_CONFIGURED();
  }

  /* Facebookログインが使える状態か（API_BASE + App ID の両方が必要） */
  function facebookConfigured() {
    return typeof window.AMP_FACEBOOK_CONFIGURED === "function" && window.AMP_FACEBOOK_CONFIGURED();
  }

  /* ---------- Facebook OAuth の戻りエラー（?auth_error=...） ---------- */
  var FB_ERROR_MESSAGES = {
    facebook_denied: "Facebookログインがキャンセルされたか、許可されませんでした。",
    facebook_in_use: "このFacebookアカウントは、別のマイページ登録に使われています。",
    state_invalid: "ログインの有効期限が切れました。もう一度お試しください。",
    facebook_token: "Facebookログインを確認できませんでした。もう一度お試しください。",
    facebook_profile: "Facebookのプロフィールを取得できませんでした。",
    facebook_network: "Facebookへ接続できませんでした。通信環境をご確認ください。",
    user_not_found: "アカウントを確認できませんでした。"
  };
  function authErrorMessage(code) {
    return FB_ERROR_MESSAGES[code] || "Facebookログインを完了できませんでした。もう一度お試しください。";
  }
  /* 戻りURLの auth_error を読み取り、URLからは取り除く（再読込での再表示防止） */
  function readAuthError() {
    try {
      var params = new URLSearchParams(location.search || "");
      var code = params.get("auth_error");
      if (!code) return null;
      params.delete("auth_error");
      var qs = params.toString();
      history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + (location.hash || ""));
      return code;
    } catch (e) { return null; }
  }

  /* ---------- 予約ドラフトの保存/復元（OAuth遷移対策） ---------- */
  function saveDraft(booking) {
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
        booking: booking, savedAt: new Date().toISOString()
      }));
    } catch (e) { /* 保存できなくても致命的ではない */ }
  }
  function loadDraft() {
    try {
      var raw = sessionStorage.getItem(DRAFT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function clearDraft() {
    try { sessionStorage.removeItem(DRAFT_KEY); } catch (e) {}
  }

  /* ==========================================================
     パスキー登録モーダル（このモジュールがDOMを注入する）
     ========================================================== */
  var modalEls = null;

  function ensureModal() {
    if (modalEls) return modalEls;
    var style = document.createElement("style");
    style.textContent =
      ".amp-modal-ov{position:fixed;inset:0;background:rgba(20,20,20,.45);z-index:9999;" +
      "display:flex;align-items:center;justify-content:center;padding:20px}" +
      ".amp-modal{background:#fff;max-width:420px;width:100%;padding:34px 30px;border:1px solid #141414;" +
      "font-family:'Helvetica Neue',Helvetica,Arial,'Hiragino Kaku Gothic ProN',sans-serif;color:#141414}" +
      ".amp-modal h3{font-size:17px;font-weight:400;letter-spacing:.14em;margin:0 0 10px}" +
      ".amp-modal p{font-size:13px;color:#6E6E6E;line-height:1.8;margin:0 0 16px}" +
      ".amp-fld{margin-bottom:14px}.amp-fld label{display:block;font-size:10px;letter-spacing:.24em;" +
      "text-transform:uppercase;color:#6E6E6E;margin-bottom:5px}" +
      ".amp-fld input{width:100%;border:none;border-bottom:1px solid #CFCBC0;background:transparent;" +
      "font:inherit;font-size:16px;padding:7px 2px;border-radius:0;box-sizing:border-box}" +
      ".amp-fld input:focus{outline:none;border-bottom-color:#141414}" +
      ".amp-mbtn{display:block;width:100%;margin-top:10px;padding:13px;background:#fff;color:#141414;" +
      "border:1px solid #141414;font:inherit;font-size:13px;letter-spacing:.14em;cursor:pointer}" +
      ".amp-mbtn.primary{background:#141414;color:#fff}" +
      ".amp-mbtn.ghost{border-color:#CFCBC0;color:#6E6E6E}" +
      ".amp-mbtn:disabled{opacity:.45;cursor:default}" +
      ".amp-merr{color:#A33327;font-size:12.5px;min-height:1.4em;margin:6px 0 2px}";
    document.head.appendChild(style);

    var ov = document.createElement("div");
    ov.className = "amp-modal-ov";
    ov.style.display = "none";
    ov.innerHTML =
      '<div class="amp-modal" role="dialog" aria-modal="true" aria-label="マイページ登録">' +
      "<h3>マイページ登録</h3>" +
      "<p>パスキーの登録には、お名前とメールアドレスが必要です。パスワードは作りません（端末のFace ID・指紋認証などを使います）。</p>" +
      '<div class="amp-fld"><label for="amp-su-name">お名前</label>' +
      '<input id="amp-su-name" type="text" autocomplete="name" placeholder="山田 太郎"></div>' +
      '<div class="amp-fld"><label for="amp-su-email">メールアドレス</label>' +
      '<input id="amp-su-email" type="email" autocomplete="email" placeholder="you@example.com"></div>' +
      '<p class="amp-merr" id="amp-su-error"></p>' +
      '<button type="button" class="amp-mbtn primary" id="amp-su-submit">パスキーで登録する</button>' +
      '<button type="button" class="amp-mbtn" id="amp-su-fb" style="display:none">続けてFacebookと連携する</button>' +
      '<button type="button" class="amp-mbtn" id="amp-su-done" style="display:none">閉じる</button>' +
      '<button type="button" class="amp-mbtn ghost" id="amp-su-cancel">あとで登録する</button>' +
      "</div>";
    document.body.appendChild(ov);

    modalEls = {
      ov: ov,
      name: ov.querySelector("#amp-su-name"),
      email: ov.querySelector("#amp-su-email"),
      error: ov.querySelector("#amp-su-error"),
      submit: ov.querySelector("#amp-su-submit"),
      fb: ov.querySelector("#amp-su-fb"),
      done: ov.querySelector("#amp-su-done"),
      cancel: ov.querySelector("#amp-su-cancel")
    };
    return modalEls;
  }

  /**
   * パスキー登録モーダルを開く。
   * @param {boolean} wantFacebook - Facebookも選択されていたか
   * @returns {Promise<{mode:string, userId?:string}>}
   */
  function openPasskeyModal(wantFacebook) {
    return new Promise(function (resolve) {
      var m = ensureModal();
      m.ov.style.display = "";
      m.error.textContent = "";
      m.fb.style.display = "none";
      m.done.style.display = "none";
      m.submit.style.display = "";
      m.cancel.style.display = "";

      function close(result) {
        m.ov.style.display = "none";
        m.submit.onclick = null; m.cancel.onclick = null;
        m.fb.onclick = null; m.done.onclick = null;
        resolve(result);
      }

      m.cancel.onclick = function () { close({ mode: "deferred", methods: {} }); };
      m.submit.onclick = function () {
        var name = (m.name.value || "").trim();
        var email = (m.email.value || "").trim();
        if (!name) { m.error.textContent = "お名前を入力してください。"; return; }
        if (!email) { m.error.textContent = "メールアドレスを入力してください。"; return; }
        m.error.textContent = "";
        m.submit.disabled = true; m.cancel.disabled = true;
        C.registerWithPasskey(name, email).then(function (user) {
          m.submit.disabled = false; m.cancel.disabled = false;
          var doneResult = { mode: "signup-completed", userId: user.id, methods: { passkey: true, facebook: false } };
          if (wantFacebook && facebookConfigured()) {
            /* 両方選ばれていてFacebookも使える：そのまま連携へ進める導線を出す */
            m.submit.style.display = "none";
            m.cancel.style.display = "none";
            m.fb.style.display = "";
            m.done.style.display = "";
            m.error.style.color = "#141414";
            m.error.textContent = "パスキーの登録が完了しました。";
            m.fb.onclick = function () {
              /* セッション Cookie が発行済みのため連携モードで遷移する */
              C.signInWithFacebook(location.href);
              close(doneResult);
            };
            m.done.onclick = function () { close(doneResult); };
          } else if (wantFacebook) {
            /* 両方選ばれたがFacebookは未設定：連携は出さず、正直に案内して閉じる */
            m.submit.style.display = "none";
            m.cancel.style.display = "none";
            m.done.style.display = "";
            m.error.style.color = "#141414";
            m.error.textContent = "パスキーの登録が完了しました。Facebook連携は現在準備中のため、使えるようになったらマイページから連携できます。";
            m.done.onclick = function () { close(doneResult); };
          } else {
            close(doneResult);
          }
        }).catch(function (e) {
          m.submit.disabled = false; m.cancel.disabled = false;
          m.error.style.color = "";
          m.error.textContent = C.friendlyError(e);
        });
      };
    });
  }

  /* ==========================================================
     公開API
     ========================================================== */

  /**
   * ステップ1「保険プランの選択へ」が押され、バリデーションを通過した直後に呼ぶ。
   * @param {object} booking - ウィザードの booking オブジェクト（reg に選択状態）
   * @returns {Promise<{mode:string, userId?:string, methods:object}>}
   *   mode: "selection-only"      … API未設定。従来動作のまま進んでよい
   *         "already-signed-in"   … ログイン済み。そのまま進んでよい
   *         "signup-completed"    … パスキー登録が完了した
   *         "facebook-redirect"   … Facebook OAuth へ遷移する（ページが離脱する）
   *         "facebook-unavailable"… Facebook未設定のため遷移しなかった。
   *                                 呼び出し側で「準備中」の案内を出すこと
   *         "deferred"            … 「あとで登録する」が選ばれた。ウィザードは止めない
   *         "error"               … 失敗。ウィザードは止めず、案内を出す
   *   methods: {passkey:boolean, facebook:boolean}
   *         サーバーで確認できた登録済み状態のみ true。未確認は false。
   */
  function onStep1Continue(booking) {
    if (!configured()) {
      return Promise.resolve({ mode: "selection-only", methods: {} });
    }
    saveDraft(booking);
    var wantPasskey = !!(booking.reg && booking.reg.passkey);
    var wantFacebook = !!(booking.reg && booking.reg.facebook);
    return C.me().then(function (user) {
      if (user) {
        return {
          mode: "already-signed-in", userId: user.id,
          methods: { passkey: !!user.hasPasskey, facebook: !!user.facebookLinked }
        };
      }

      if (wantFacebook && !wantPasskey) {
        if (!facebookConfigured()) {
          /* 未設定のまま遷移すると Worker の 503 画面に取り残されるため遷移しない */
          return { mode: "facebook-unavailable", methods: {} };
        }
        C.signInWithFacebook(location.href);
        return { mode: "facebook-redirect", methods: {} };
      }
      if (wantPasskey) {
        return openPasskeyModal(wantFacebook);
      }
      return { mode: "selection-only", methods: {} };
    }).catch(function () {
      return { mode: "error", methods: {} };
    });
  }

  /**
   * ステップ1で登録方法のカードがタップされ、選択状態になった直後に呼ぶ。
   * その場で該当する方法の登録を開始する（パスキー＝モーダル、Facebook＝OAuth遷移）。
   * @param {string} key - "passkey" | "facebook"
   * @param {object} booking - ウィザードの booking オブジェクト
   * @returns {Promise<{mode:string, userId?:string, methods:object}>} onStep1Continue と同じ形式
   */
  function registerMethod(key, booking) {
    if (!configured()) {
      return Promise.resolve({ mode: "selection-only", methods: {} });
    }
    saveDraft(booking);
    return C.me().then(function (user) {
      if (user) {
        if (key === "passkey" && !user.hasPasskey) {
          return C.addPasskey().then(function () {
            return { mode: "passkey-added", userId: user.id, methods: { passkey: true, facebook: !!user.facebookLinked } };
          });
        }
        if (key === "facebook" && !user.facebookLinked) {
          if (!facebookConfigured()) {
            return { mode: "facebook-unavailable", methods: {} };
          }
          C.signInWithFacebook(location.href);
          return { mode: "facebook-redirect", methods: {} };
        }
        return {
          mode: "already-signed-in", userId: user.id,
          methods: { passkey: !!user.hasPasskey, facebook: !!user.facebookLinked }
        };
      }
      if (key === "facebook") {
        if (!facebookConfigured()) {
          return { mode: "facebook-unavailable", methods: {} };
        }
        C.signInWithFacebook(location.href);
        return { mode: "facebook-redirect", methods: {} };
      }
      return openPasskeyModal(false);
    }).catch(function () {
      return { mode: "error", methods: {} };
    });
  }

  /**
   * ページ読み込み時に呼ぶ。OAuth から戻ってきた場合に、
   * ログイン状態とドラフトを返す（復元の適用は index.html 側で行う）。
   * @returns {Promise<{signedIn:boolean, userId:?string, user:?object, draft:?object, authError:?string}>}
   *   user は /auth/me の形（hasPasskey / facebookLinked を含む）。
   *   authError は Facebook 側で失敗して戻ってきた場合の理由コード
   *   （authErrorMessage() で表示文言に変換できる）。
   */
  function restoreIfReturned() {
    var draft = loadDraft();
    var authError = readAuthError();
    if (!configured()) {
      return Promise.resolve({ signedIn: false, userId: null, user: null, draft: draft, authError: authError });
    }
    return C.me().then(function (user) {
      return { signedIn: !!user, userId: user ? user.id : null, user: user, draft: draft, authError: authError };
    }).catch(function () {
      return { signedIn: false, userId: null, user: null, draft: draft, authError: authError };
    });
  }

  /**
   * ログイン済みユーザーにパスキーを追加する（Facebook登録者が後から
   * パスキーも使えるようにする「両方選べます」の後付け用）。
   * マイページの「パスキーを追加」からも利用する想定。
   */
  function addPasskey() {
    if (!configured()) return Promise.resolve({ mode: "selection-only" });
    return C.me().then(function (user) {
      if (!user) return { mode: "signed-out" };
      return C.addPasskey().then(function () { return { mode: "passkey-added" }; });
    }).catch(function (e) {
      return { mode: "error", error: e };
    });
  }

  /** 現在のログインユーザーを返す（未ログイン/未設定なら null） */
  function currentUser() {
    if (!configured()) return Promise.resolve(null);
    return C.me();
  }

  /**
   * 保険の加入詳細スクリーンショットをアップロードする。
   * 未設定（デプロイ前）はローカル保存にフォールバックし {mode:"local"} を返す。
   */
  function uploadInsurance(dataUrl) {
    if (!configured() || !C.uploadInsurance) {
      try { localStorage.setItem("amp_insurance_shot", dataUrl); } catch (e) {}
      return Promise.resolve({ mode: "local" });
    }
    return C.uploadInsurance(dataUrl, null).then(function (r) {
      return { mode: "uploaded", id: r && r.id };
    });
  }

  return {
    configured: configured,
    facebookConfigured: facebookConfigured,
    authErrorMessage: authErrorMessage,
    uploadInsurance: uploadInsurance,
    onStep1Continue: onStep1Continue,
    registerMethod: registerMethod,
    restoreIfReturned: restoreIfReturned,
    addPasskey: addPasskey,
    currentUser: currentUser,
    saveDraft: saveDraft,
    loadDraft: loadDraft,
    clearDraft: clearDraft
  };
})();

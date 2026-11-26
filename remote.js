'use strict';
(() => {
  const login = document.getElementById('login-screen');
  const app = document.getElementById('private-app');
  const content = document.getElementById('private-content');
  const loginStatus = document.getElementById('login-status');
  const appStatus = document.getElementById('app-status');
  const accountName = document.getElementById('account-name');
  const labels = {overview:'ホーム',cards:'カード',settlements:'精算',sources:'取得状況'};
  let config;
  let credential = null;
  let expiryTimer;
  let currentPage = 'overview';
  let currentYear = null;
  let requestVersion = 0;
  let editing = false;
  let displayedDay = null;

  function logout(message = 'Googleアカウントでログインしてください。') {
    credential = null;
    requestVersion++;
    clearTimeout(expiryTimer);
    content.replaceChildren();
    accountName.textContent = '';
    app.hidden = true;
    login.hidden = false;
    loginStatus.textContent = message;
    if (window.google?.accounts?.id) window.google.accounts.id.disableAutoSelect();
  }

  async function api(path, options = {}) {
    if (!credential) throw new Error('Googleログインが必要です。');
    let response;
    try {
      response = await fetch(config.api_base_url + path, {...options, cache:'no-store', credentials:'omit',
        headers:{'Authorization':'Bearer ' + credential,...options.headers}});
    } catch {
      throw new Error('自宅APIに接続できません。マシンの起動とTailscale Funnelを確認してください。');
    }
    if (response.status === 401 || response.status === 403) {
      const message = response.status === 403 ? 'このGoogleアカウントでは利用できません。' : 'ログインの有効期限が切れました。もう一度ログインしてください。';
      logout(message);
      throw new Error(message);
    }
    if (!response.ok) throw new Error('処理を完了できませんでした。接続と入力内容を確認してください。');
    return response.json();
  }

  function render(result) {
    if (!credential || !labels[result.page] || typeof result.html !== 'string') return;
    const documentFragment = new DOMParser().parseFromString(result.html, 'text/html');
    const main = documentFragment.querySelector('main');
    if (!main) throw new Error('画面を読み込めませんでした。');
    for (const node of main.querySelectorAll('script,iframe,object,embed,base,style,link')) node.remove();
    for (const node of main.querySelectorAll('*')) {
      for (const attribute of [...node.attributes]) {
        if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
        if (['href','src','action'].includes(attribute.name) && /^\s*javascript:/i.test(attribute.value)) node.removeAttribute(attribute.name);
      }
    }
    content.replaceChildren(document.importNode(main, true));
    currentPage = result.page;
    currentYear = result.year;
    displayedDay = result.day;
    editing = false;
    for (const link of app.querySelectorAll('nav a')) {
      if (link.dataset.page === currentPage) link.setAttribute('aria-current','page');
      else link.removeAttribute('aria-current');
    }
    document.title = labels[currentPage] + ' | 家計簿';
    history.replaceState(null,'','#' + currentPage);
    appStatus.textContent = '';
  }

  async function loadPage(page = currentPage, year = currentYear) {
    if (!labels[page]) return;
    const version = ++requestVersion;
    appStatus.textContent = '読み込んでいます。';
    try {
      const result = await api('/api/view/' + page + (year ? '?year=' + encodeURIComponent(year) : ''));
      if (version === requestVersion && credential) render(result);
    } catch (error) {
      if (version === requestVersion && credential) appStatus.textContent = error.message;
      else if (!credential) loginStatus.textContent = error.message;
    }
  }

  async function signedIn(response) {
    if (!response.credential) return;
    credential = response.credential;
    loginStatus.textContent = '本人確認をしています。';
    try {
      const session = await api('/api/session');
      if (!credential) return;
      clearTimeout(expiryTimer);
      const remaining = Number(session.expires_at) * 1000 - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        logout('もう一度Googleログインしてください。');
        return;
      }
      expiryTimer = setTimeout(() => logout('ログインの有効期限が切れました。'), Math.min(remaining,2147483647));
      accountName.textContent = session.email;
      login.hidden = true;
      app.hidden = false;
      const page = location.hash.slice(1);
      await loadPage(labels[page] ? page : 'overview');
    } catch (error) {
      logout(error.message);
    }
  }

  document.getElementById('logout').addEventListener('click', () => logout());
  document.addEventListener('click', event => {
    const link = event.target.closest('a');
    if (!link || !credential || event.ctrlKey || event.metaKey) return;
    const pages = {'/':'overview','/cards':'cards','/settlements':'settlements','/sources':'sources'};
    const page = link.dataset.page || pages[link.getAttribute('href')];
    if (page) {
      event.preventDefault();
      loadPage(page);
    }
  });
  content.addEventListener('input', () => { editing = true; });
  content.addEventListener('submit', async event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    const fields = Object.fromEntries([...new FormData(form)].map(([key,value]) => [key,String(value)]));
    if (form.method.toLowerCase() === 'get') {
      await loadPage('overview', fields.year);
      return;
    }
    const path = form.getAttribute('action');
    if (!path || !path.startsWith('/') || path.startsWith('//')) return;
    delete fields.csrf;
    const buttons = [...form.querySelectorAll('button[type=submit]')];
    buttons.forEach(button => button.disabled = true);
    const version = ++requestVersion;
    appStatus.textContent = '保存しています。';
    try {
      const result = await api('/api/action', {method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({path,fields,year:currentYear})});
      if (version === requestVersion && credential) {
        render(result);
        content.querySelector('[role=alert],.success-message')?.scrollIntoView({block:'center'});
      }
    } catch (error) {
      if (credential) appStatus.textContent = error.message;
    } finally {
      buttons.forEach(button => button.disabled = false);
    }
  });

  setInterval(() => {
    const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0,10);
    if (credential && displayedDay && displayedDay !== today && !editing && !content.querySelector('.notice.demo')) loadPage();
  },60000);

  async function initialize() {
    try {
      const response = await fetch('./config.json', {cache:'no-store'});
      config = await response.json();
      const apiURL = new URL(config.api_base_url);
      if (apiURL.protocol !== 'https:' || apiURL.username || apiURL.password || apiURL.search || apiURL.hash || apiURL.pathname !== '/' || !config.google_client_id?.endsWith('.apps.googleusercontent.com')) throw new Error();
      config.api_base_url = apiURL.origin;
    } catch {
      loginStatus.textContent = 'Googleログインと自宅APIの初期設定が必要です。';
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => {
      document.getElementById('google-button').replaceChildren();
      window.google.accounts.id.initialize({client_id:config.google_client_id,callback:signedIn,auto_select:false});
      window.google.accounts.id.renderButton(document.getElementById('google-button'),{theme:'outline',size:'large',width:260,locale:'ja'});
      loginStatus.textContent = 'Googleアカウントでログインしてください。';
    };
    script.onerror = () => { loginStatus.textContent = 'Googleログインを読み込めませんでした。再読込してください。'; };
    document.head.append(script);
  }
  initialize();
})();

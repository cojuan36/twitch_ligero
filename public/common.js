const $ = (id) => document.getElementById(id);
const page = document.querySelector('[data-page]').dataset.page;
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const showError = (error) => { $('error').textContent = error.message; };
let me;

async function api(path, method = 'GET', body) {
  const response = await fetch('/api/' + path, { method,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Error de conexión');
  return data;
}
function action(handler) {
  return async event => {
    event.preventDefault();
    $('error').textContent = '';
    try { await handler(event); } catch (error) { showError(error); }
  };
}
function bindForm(id, handler) {
  $(id).onsubmit = action(event => handler(Object.fromEntries(new FormData(event.currentTarget))));
}
async function explore() {
  const params = new URLSearchParams(location.search);
  const following = params.get('tab') === 'following';
  if (following && !me) return location.replace('/login.html');
  $('heading').textContent = following ? 'Siguiendo' : 'Explorar';
  let selected = params.get('category') || '';
  async function load() {
    const [categories, channels, list] = await Promise.all([
      api('categories'), api('channels'), following ? api('following') : Promise.resolve(null)
    ]);
    $('sidebar').innerHTML = channels.slice(0, 12).map(c =>
      '<a href="/c/' + c.username + '">' + c.username + (c.is_live ? ' · En vivo' : '') + '</a>').join('');
    $('filters').replaceChildren(...[{ name: 'Todas', value: '' }, ...categories].map(item => {
      const button = document.createElement('button');
      const value = item.value ?? item.name;
      button.textContent = item.name + (item.live ? ' · ' + item.live : '');
      button.setAttribute('aria-pressed', String(value === selected));
      button.onclick = action(() => {
        selected = value;
        if (value) params.set('category', value); else params.delete('category');
        history.replaceState(null, '', '/' + (params.size ? '?' + params : ''));
        return load();
      });
      return button;
    }));
    $('cards').innerHTML = (list || channels).filter(c => !selected || c.category === selected).map(c =>
      `<a class="card" href="/c/${c.username}">
        <div class="thumb">${c.username[0].toUpperCase()}
        ${c.is_live ? `<img alt="" src="${c.thumb}" onerror="this.remove()">` : ''}
        <small class="${c.is_live ? 'live' : ''}">${c.is_live ? 'EN VIVO' : 'DESCONECTADO'}</small></div>
        <strong>${escape(c.title)}</strong><p>${c.username} · ${escape(c.category)}</p>
        ${c.is_live ? `<p>${c.viewers} espectadores</p>` : ''}</a>`).join('') ||
      '<p>No hay canales en esta vista.</p>';
  }
  const socket = io();
  socket.on('live', () => {
    load().catch(showError);
    setTimeout(() => load().catch(showError), 4500);
  });
  await load();
  setInterval(() => load().catch(showError), 15000);
}
function login() {
  const register = location.hash === '#register';
  $('heading').textContent = register ? 'Crear cuenta' : 'Iniciar sesión';
  $('submit').textContent = register ? 'Registrarme' : 'Entrar';
  $('switch-mode').textContent = register ? 'Iniciar sesión' : 'Crear cuenta';
  $('switch-mode').href = register ? '/login.html' : '/login.html#register';
  $('account').elements.password.autocomplete = register ? 'new-password' : 'current-password';
  window.addEventListener('hashchange', login, { once: true });
  bindForm('account', async body => {
    await api(register ? 'register' : 'login', 'POST', body);
    location.href = register ? '/dashboard.html' : '/';
  });
}
async function dashboard() {
  if (!me) return location.replace('/login.html');
  const d = await api('dashboard');
  const setStatus = live => { $('status').textContent = live ? 'En vivo' : 'Desconectado'; };
  setStatus(d.is_live);
  const form = $('profile').elements;
  form.title.value = d.title;
  form.bio.value = d.bio;
  form.category.replaceChildren(...d.categories.map(name => new Option(name)));
  form.category.value = d.category;
  $('view-channel').href = '/c/' + d.username;
  $('rtmp').value = d.rtmp_url;
  $('key').value = d.obs_key;
  $('toggle-key').onclick = () => {
    const show = $('key').type === 'password';
    $('key').type = show ? 'text' : 'password';
    $('toggle-key').textContent = show ? 'Ocultar clave' : 'Mostrar clave';
  };
  $('regen').onclick = action(async () => {
    if (!confirm('¿Regenerar la clave? La anterior dejará de funcionar.')) return;
    $('key').value = (await api('dashboard/regenerate-key', 'POST')).obs_key;
    $('error').textContent = 'Clave actualizada';
  });
  bindForm('profile', async body => {
    await api('dashboard', 'PUT', body);
    $('error').textContent = 'Cambios guardados';
  });
  io().on('live', event => { if (event.username === d.username) setStatus(event.live); });
}
async function watch() {
  const name = location.pathname.split('/')[2];
  if (!name) throw new Error('Abre un canal desde Explorar');
  const path = 'channels/' + name;
  const video = $('video');
  let channel = await api(path);
  let hls;
  let retry;
  let mode;

  function render() {
    $('title').textContent = channel.title;
    $('metadata').textContent = '@' + name + ' · ' + channel.category;
    $('counts').textContent = (channel.is_live ? 'En vivo · ' : 'Desconectado · ') +
      channel.viewers + ' espectadores · ' + channel.followers + ' seguidores';
    $('bio').textContent = channel.bio;
    $('follow').hidden = me?.username === name;
    $('follow').textContent = channel.following ? 'Dejar de seguir' : 'Seguir';
    $('vods').replaceChildren(...channel.vods.map(vod => {
      const button = document.createElement('button');
      button.textContent = new Date(Number(vod.file.split('.')[0])).toLocaleString('es-MX');
      button.onclick = () => play(vod.url, 'vod');
      return button;
    }));
    if (!channel.vods.length) $('vods').textContent = 'Todavía no hay grabaciones.';
  }
  function play(url, nextMode) {
    clearTimeout(retry);
    hls?.destroy();
    video.removeAttribute('src');
    video.load();
    mode = nextMode;
    video.hidden = !url;
    $('offline').hidden = Boolean(url);
    if (!url) return;
    const start = () => video.play().catch(() => {});
    video.muted = mode === 'live';
    if (mode === 'live' && Hls.isSupported()) {
      hls = new Hls({ liveSyncDurationCount: 2 });
      hls.on(Hls.Events.MANIFEST_PARSED, start);
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) retry = setTimeout(() => play(url, 'live'), 2000);
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else {
      video.src = url;
      start();
    }
  }
  video.onerror = () => {
    if (mode === 'live' && !Hls.isSupported() && video.canPlayType('application/vnd.apple.mpegurl')) {
      retry = setTimeout(() => play(channel.hls, 'live'), 2000);
    }
  };
  $('follow').onclick = action(async () => {
    if (!me) return location.assign('/login.html');
    Object.assign(channel, await api(path + '/follow', 'POST'));
    render();
  });
  const socket = io();
  socket.on('connect', () => socket.emit('join', name));
  socket.on('viewers', n => { channel.viewers = n; render(); });
  socket.on('channel:update', changes => { Object.assign(channel, changes); render(); });
  socket.on('live', async event => {
    if (event.username !== name) return;
    try {
      channel = await api(path);
      if (mode !== 'vod' && (channel.is_live ? mode !== 'live' : mode !== 'offline')) {
        play(channel.is_live ? channel.hls : null, channel.is_live ? 'live' : 'offline');
      }
      render();
    } catch (error) { showError(error); }
  });
  socket.on('chat', message => {
    const row = document.createElement('p');
    const author = document.createElement('strong');
    author.style.color = message.color;
    author.textContent = message.user + ' · ';
    row.append(author, message.text);
    const log = $('messages');
    log.append(row);
    if (log.childElementCount > 150) log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
  });
  socket.on('chat:error', text => { $('chat-error').textContent = text; });
  if (me) bindForm('chat', ({ text }) => {
    $('chat-error').textContent = '';
    socket.emit('chat', text);
    $('chat').reset();
  });
  else $('chat').innerHTML = '<a href="/login.html">Inicia sesión para escribir</a>';
  render();
  play(channel.is_live ? channel.hls : null, channel.is_live ? 'live' : 'offline');
}

async function boot() {
  me = (await api('me')).user;
  $('nav').innerHTML = '<a href="/">Explorar</a>' + (me
    ? '<a href="/?tab=following">Siguiendo</a><a href="/dashboard.html">Mi canal</a><button id="logout">Salir</button>'
    : '<a href="/login.html">Iniciar sesión</a><a href="/login.html#register">Registrarse</a>');
  if (me) $('logout').onclick = action(async () => { await api('logout', 'POST'); location.href = '/'; });
  await ({ explore, login, dashboard, channel: watch })[page]();
}
boot().catch(showError);

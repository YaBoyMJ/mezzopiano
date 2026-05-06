/* ═══════════════════════════════════════════════════════════
   Mezzo-Piano — mezzo-app.js
   Account system + IndexedDB: songs (with blobs) persist
   across reloads. Each account gets its own database.
   ═══════════════════════════════════════════════════════════ */

// ─── APP STATE ────────────────────────────────────────────
let library   = [];
let queue     = [];
let queueIndex = -1;
let playlists = [];
let pendingFiles = [];
let pendingIdx   = -1;
let shuffle    = false;
let repeatMode = 'none';
let currentView       = 'home';
let currentPlaylistId = null;
let ctxSongId  = null;
let ctxSource  = null;
let currentUser = null;

const audio = document.getElementById('audioEl');

// ─── AUTH ─────────────────────────────────────────────────
// Accounts stored in localStorage: { username: hashedPassword }
// Session stored in localStorage: sw_mp_session = username

function hashPassword(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return (h >>> 0).toString(16);
}

function getAccounts() {
  try { return JSON.parse(localStorage.getItem('mp_accounts') || '{}'); } catch { return {}; }
}
function saveAccounts(a) { localStorage.setItem('mp_accounts', JSON.stringify(a)); }

function switchAuthTab(tab) {
  document.getElementById('tabLogin').classList.toggle('active', tab === 'login');
  document.getElementById('tabRegister').classList.toggle('active', tab === 'register');
  document.getElementById('formLogin').style.display    = tab === 'login'    ? 'flex' : 'none';
  document.getElementById('formRegister').style.display = tab === 'register' ? 'flex' : 'none';
  document.getElementById('loginError').textContent = '';
  document.getElementById('regError').textContent   = '';
}

function doLogin() {
  const user = document.getElementById('loginUser').value.trim().toLowerCase();
  const pass = document.getElementById('loginPass').value;
  const errEl = document.getElementById('loginError');
  if (!user || !pass) { errEl.textContent = 'please fill in all fields.'; return; }
  const accounts = getAccounts();
  if (!accounts[user]) { errEl.textContent = 'account not found.'; return; }
  if (accounts[user] !== hashPassword(pass)) { errEl.textContent = 'incorrect password.'; return; }
  localStorage.setItem('mp_session', user);
  startApp(user);
}

function doRegister() {
  const user  = document.getElementById('regUser').value.trim().toLowerCase();
  const pass  = document.getElementById('regPass').value;
  const pass2 = document.getElementById('regPass2').value;
  const errEl = document.getElementById('regError');
  if (!user || !pass) { errEl.textContent = 'please fill in all fields.'; return; }
  if (!/^[a-z0-9_]{2,20}$/.test(user)) { errEl.textContent = 'username: 2-20 chars, letters/numbers/underscores only.'; return; }
  if (pass.length < 4) { errEl.textContent = 'password must be at least 4 characters.'; return; }
  if (pass !== pass2)  { errEl.textContent = 'passwords do not match.'; return; }
  const accounts = getAccounts();
  if (accounts[user]) { errEl.textContent = 'username already taken.'; return; }
  accounts[user] = hashPassword(pass);
  saveAccounts(accounts);
  localStorage.setItem('mp_session', user);
  startApp(user);
}

function doSignOut() {
  library.forEach(s => { if (s.url) URL.revokeObjectURL(s.url); });
  library = []; queue = []; queueIndex = -1; playlists = [];
  currentUser = null;
  if (db) { db.close(); db = null; }
  localStorage.removeItem('mp_session');

  const a = document.getElementById('audioEl');
  a.pause(); a.src = '';
  document.getElementById('playerTitle').textContent  = 'No track playing';
  document.getElementById('playerArtist').textContent = '—';
  document.getElementById('playIcon').style.display   = '';
  document.getElementById('pauseIcon').style.display  = 'none';

  document.getElementById('sidebar').style.display = 'none';
  document.getElementById('main').style.display    = 'none';
  document.getElementById('player').style.display  = 'none';
  document.getElementById('authOverlay').classList.remove('hidden');

  document.getElementById('loginUser').value = '';
  document.getElementById('loginPass').value = '';
  document.getElementById('loginError').textContent = '';
  document.title = 'Mezzo-Piano | Find your dynamic';
}

// ─── INDEXEDDB ────────────────────────────────────────────
// Each user gets their own DB: "mezzopiano_<username>"
// Stores:
//   songs  { id, title, artist, album, cover, duration, liked, addedAt, blob }
//   meta   { key, value }

let db = null;

function openDB(username) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('mezzopiano_' + username, 1);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('songs')) d.createObjectStore('songs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta'))  d.createObjectStore('meta',  { keyPath: 'key' });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function dbPut(store, value) {
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readwrite').objectStore(store).put(value);
    r.onsuccess = () => res();
    r.onerror   = e => rej(e.target.error);
  });
}
function dbGet(store, key) {
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readonly').objectStore(store).get(key);
    r.onsuccess = e => res(e.target.result);
    r.onerror   = e => rej(e.target.error);
  });
}
function dbGetAll(store) {
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readonly').objectStore(store).getAll();
    r.onsuccess = e => res(e.target.result);
    r.onerror   = e => rej(e.target.error);
  });
}
function dbDelete(store, key) {
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readwrite').objectStore(store).delete(key);
    r.onsuccess = () => res();
    r.onerror   = e => rej(e.target.error);
  });
}

// ─── SAVE / LOAD ──────────────────────────────────────────

// Save a song including its audio blob — this is the key to persistence
async function saveSong(song) {
  let blob = song.blob || null;
  // If we only have an object URL, fetch the underlying blob from it
  if (!blob && song.url) {
    try { blob = await fetch(song.url).then(r => r.blob()); } catch(e) { console.warn('blob fetch failed', e); }
  }
  if (!blob) { console.warn('no blob available for', song.title); return; }
  song.blob = blob; // keep in-memory reference current
  await dbPut('songs', {
    id: song.id, title: song.title, artist: song.artist,
    album: song.album, cover: song.cover, duration: song.duration,
    liked: song.liked, addedAt: song.addedAt,
    blob  // ← actual audio data stored in IndexedDB
  });
}

async function savePlaylists() {
  // Deep copy so IndexedDB doesn't hold live references
  await dbPut('meta', { key: 'playlists', value: JSON.parse(JSON.stringify(playlists)) });
}

async function save() {
  try { await savePlaylists(); } catch(e) { console.warn('save error', e); }
}

async function loadUserData() {
  try {
    const pm = await dbGet('meta', 'playlists');
    if (pm) playlists = pm.value || [];

    const rows = await dbGetAll('songs');
    library = [];
    for (const row of rows) {
      // Reconstruct a playable object URL from the stored blob
      const url = row.blob ? URL.createObjectURL(row.blob) : null;
      library.push({ ...row, url });
    }
    library.sort((a, b) => b.addedAt - a.addedAt);
  } catch(e) { console.warn('loadUserData error', e); }
}

// ─── START APP ────────────────────────────────────────────
async function startApp(username) {
  currentUser = username;
  db = await openDB(username);
  await loadUserData();

  document.getElementById('authOverlay').classList.add('hidden');
  document.getElementById('sidebar').style.display = 'flex';
  document.getElementById('main').style.display    = 'block';
  document.getElementById('player').style.display  = 'grid';

  document.getElementById('accountName').textContent   = username;
  document.getElementById('accountAvatar').textContent = username[0].toUpperCase();

  setGreeting();
  renderAll();
  setVolume(80);
}

// ─── INIT ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  ['loginUser','loginPass'].forEach(id =>
    document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); })
  );
  ['regUser','regPass','regPass2'].forEach(id =>
    document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); })
  );

  document.addEventListener('click', e => { if (!e.target.closest('.context-menu')) hideContextMenu(); });
  document.addEventListener('contextmenu', e => { if (!e.target.closest('.song-row, .song-card')) hideContextMenu(); });

  // Resume session if one exists
  const saved = localStorage.getItem('mp_session');
  if (saved && getAccounts()[saved]) startApp(saved);
});

function setGreeting() {
  const h = new Date().getHours();
  document.getElementById('greeting').textContent =
    h < 12 ? 'good morning.' : h < 17 ? 'good afternoon.' : 'good evening.';
}

// ─── VIEW ROUTING ──────────────────────────────────────────
function showView(name, playlistId) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.playlist-item').forEach(p => p.classList.remove('active'));

  currentView = name;
  document.getElementById('view-' + name).classList.add('active');
  const btn = document.querySelector(`[data-view="${name}"]`);
  if (btn) btn.classList.add('active');

  if (name === 'playlist' && playlistId != null) {
    currentPlaylistId = playlistId;
    renderPlaylistView(playlistId);
    const pItem = document.querySelector(`.playlist-item[data-id="${playlistId}"]`);
    if (pItem) pItem.classList.add('active');
  }
  if (name === 'home')    renderHome();
  if (name === 'library') renderLibrary();
}

function renderAll() {
  renderSidebar();
  if (currentView === 'home')     renderHome();
  if (currentView === 'library')  renderLibrary();
  if (currentView === 'playlist') renderPlaylistView(currentPlaylistId);
}

// ─── SIDEBAR ──────────────────────────────────────────────
function renderSidebar() {
  document.getElementById('playlistSidebar').innerHTML = playlists.map(p => `
    <div class="playlist-item" data-id="${p.id}" onclick="showView('playlist',${p.id})">
      <svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
      ${escHtml(p.name)}
    </div>`).join('');
}

// ─── HOME ─────────────────────────────────────────────────
function renderHome() {
  const recent = [...library].sort((a,b) => b.addedAt - a.addedAt).slice(0,8);
  renderSongGrid('recentGrid', recent);
  renderSongListEl('allSongsList', library);
}

function renderSongGrid(containerId, songs) {
  const el = document.getElementById(containerId);
  if (!songs.length) {
    el.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <svg viewBox="0 0 24 24" width="40" height="40" stroke="currentColor" fill="none" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
      <p>no songs yet — head to upload to add music!</p></div>`;
    return;
  }
  el.innerHTML = songs.map(s => `
    <div class="song-card ${isCurrentSong(s.id)?'playing':''}"
         onclick="playSong(${s.id})" oncontextmenu="showCtxMenu(event,${s.id})">
      <div class="card-art">
        ${s.cover ? `<img src="${escHtml(s.cover)}" alt="" onerror="this.style.display='none'">` : musicIcon()}
        <div class="card-play-overlay">
          ${isCurrentSong(s.id) ? eqBars() : `<svg viewBox="0 0 24 24" width="28" height="28" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg>`}
        </div>
      </div>
      <div class="card-title">${escHtml(s.title)}</div>
      <div class="card-artist">${escHtml(s.artist||'Unknown Artist')}</div>
    </div>`).join('');
}

function renderSongListEl(containerId, songs, source='library') {
  const el = document.getElementById(containerId);
  if (!songs.length) {
    el.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" width="40" height="40" stroke="currentColor" fill="none" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
      <p>nothing here yet.</p></div>`;
    return;
  }
  el.innerHTML = `
    <div class="list-header">
      <span>#</span><span></span><span>Title</span><span>Album</span><span>Duration</span><span></span>
    </div>
    ${songs.map((s,i) => `
      <div class="song-row ${isCurrentSong(s.id)?'playing':''}"
           onclick="playSongFromList(${s.id},'${source}')"
           oncontextmenu="showCtxMenu(event,${s.id},'${source}')">
        <div class="row-num">
          <span class="row-num-text">${i+1}</span>
          <span class="row-play-icon" style="display:none"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></span>
        </div>
        <div class="row-art">
          ${s.cover ? `<img src="${escHtml(s.cover)}" alt="" onerror="this.style.display='none'">` :
            `<svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`}
        </div>
        <div class="row-info">
          <div class="row-title">${isCurrentSong(s.id)?eqBars()+' ':''}${escHtml(s.title)}</div>
          <div class="row-artist">${escHtml(s.artist||'Unknown Artist')}</div>
        </div>
        <div class="row-album">${escHtml(s.album||'—')}</div>
        <div class="row-duration">${s.duration||'—'}</div>
        <button class="row-more" onclick="event.stopPropagation();showCtxMenu(event,${s.id},'${source}')">
          <svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
        </button>
      </div>`).join('')}`;

  el.querySelectorAll('.song-row').forEach(row => {
    row.addEventListener('mouseenter', () => {
      row.querySelector('.row-num-text').style.display  = 'none';
      row.querySelector('.row-play-icon').style.display = 'flex';
    });
    row.addEventListener('mouseleave', () => {
      row.querySelector('.row-num-text').style.display  = '';
      row.querySelector('.row-play-icon').style.display = 'none';
    });
  });
}

// ─── LIBRARY ──────────────────────────────────────────────
let librarySorted = 'recent';
let libraryFilter = '';

function renderLibrary() {
  let songs = [...library];
  if (libraryFilter) {
    const q = libraryFilter.toLowerCase();
    songs = songs.filter(s =>
      s.title.toLowerCase().includes(q) ||
      (s.artist||'').toLowerCase().includes(q) ||
      (s.album||'').toLowerCase().includes(q));
  }
  if (librarySorted === 'title')       songs.sort((a,b) => a.title.localeCompare(b.title));
  else if (librarySorted === 'artist') songs.sort((a,b) => (a.artist||'').localeCompare(b.artist||''));
  else songs.sort((a,b) => b.addedAt - a.addedAt);
  renderSongListEl('libraryList', songs);
}

function filterLibrary(val) { libraryFilter = val; renderLibrary(); }
function sortLibrary(val)   { librarySorted = val; renderLibrary(); }

// ─── PLAYLIST VIEW ────────────────────────────────────────
function renderPlaylistView(id) {
  const p = playlists.find(p => p.id === id);
  if (!p) return;
  const songs = p.songIds.map(sid => library.find(s => s.id === sid)).filter(Boolean);
  document.getElementById('playlistName').textContent = p.name;
  document.getElementById('playlistInfo').textContent = `${songs.length} song${songs.length!==1?'s':''}`;
  const cover = songs.find(s => s.cover);
  document.getElementById('playlistCover').innerHTML = cover
    ? `<img src="${escHtml(cover.cover)}" alt="">`
    : `<svg viewBox="0 0 24 24" width="60" height="60" stroke="var(--accent)" fill="none" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
  renderSongListEl('playlistSongs', songs, `playlist_${id}`);
}

// ─── PLAYLISTS ────────────────────────────────────────────
async function createPlaylist() {
  const name = prompt('playlist name:');
  if (!name || !name.trim()) return;
  const pl = { id: Date.now(), name: name.trim(), songIds: [] };
  playlists.push(pl);
  await save();
  renderSidebar();
  showToast(`"${pl.name}" created`);
}

async function renameCurrentPlaylist() {
  const p = playlists.find(p => p.id === currentPlaylistId);
  if (!p) return;
  const name = prompt('new name:', p.name);
  if (!name || !name.trim()) return;
  p.name = name.trim();
  await save();
  renderAll();
}

async function deleteCurrentPlaylist() {
  const p = playlists.find(p => p.id === currentPlaylistId);
  if (!p || !confirm(`delete playlist "${p.name}"?`)) return;
  playlists = playlists.filter(x => x.id !== currentPlaylistId);
  await save();
  renderAll();
  showView('home');
}

function playPlaylist() {
  const p = playlists.find(p => p.id === currentPlaylistId);
  if (!p) return;
  const songs = p.songIds.map(sid => library.find(s => s.id === sid)).filter(Boolean);
  if (!songs.length) return showToast('playlist is empty');
  queue = [...songs];
  queueIndex = 0;
  loadAndPlay(queue[0]);
}

// ─── UPLOAD ───────────────────────────────────────────────
function handleDragOver(e) {
  e.preventDefault();
  document.getElementById('uploadZone').classList.add('drag-over');
}
function handleDragLeave() {
  document.getElementById('uploadZone').classList.remove('drag-over');
}
function handleDrop(e) {
  e.preventDefault();
  document.getElementById('uploadZone').classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('audio/'));
  if (files.length) stageFiles(files);
}
function handleFileSelect(e) {
  stageFiles(Array.from(e.target.files));
  e.target.value = '';
}
function stageFiles(files) {
  pendingFiles = [...pendingFiles, ...files];
  renderUploadQueue();
}
function renderUploadQueue() {
  const el = document.getElementById('uploadQueue');
  if (!pendingFiles.length) { el.innerHTML = ''; return; }
  el.innerHTML = pendingFiles.map((f,i) => `
    <div class="queue-item ${pendingIdx===i?'selected':''}" onclick="selectPending(${i})">
      <div class="queue-item-icon"><svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>
      <div class="queue-item-name">${escHtml(f.name.replace(/\.[^/.]+$/,''))}</div>
      <div class="queue-item-size">${formatBytes(f.size)}</div>
      <div class="queue-item-edit">click to edit</div>
    </div>`).join('');
}
function selectPending(i) {
  pendingIdx = i;
  const f = pendingFiles[i];
  document.getElementById('editTitle').value  = f.name.replace(/\.[^/.]+$/,'');
  document.getElementById('editArtist').value = '';
  document.getElementById('editAlbum').value  = '';
  document.getElementById('editCover').value  = '';
  document.getElementById('metadataForm').style.display = 'block';
  renderUploadQueue();
}

async function saveMetadata() {
  if (pendingIdx < 0) return;
  const f   = pendingFiles[pendingIdx];
  const url = URL.createObjectURL(f);
  const song = {
    id:       Date.now() + Math.floor(Math.random() * 1000),
    title:    document.getElementById('editTitle').value.trim()  || f.name.replace(/\.[^/.]+$/,''),
    artist:   document.getElementById('editArtist').value.trim(),
    album:    document.getElementById('editAlbum').value.trim(),
    cover:    document.getElementById('editCover').value.trim(),
    url,
    blob:     f,        // File extends Blob — IndexedDB stores it directly
    duration: null,
    liked:    false,
    addedAt:  Date.now()
  };

  library.unshift(song);
  pendingFiles.splice(pendingIdx, 1);
  pendingIdx = -1;
  document.getElementById('metadataForm').style.display = 'none';
  renderUploadQueue();
  renderAll();
  showToast(`"${song.title}" saved to library`);

  // Save to IndexedDB immediately (blob stored here = survives reload)
  await saveSong(song);

  // Patch duration once audio metadata loads, then re-save
  const tmp = new Audio(url);
  tmp.addEventListener('loadedmetadata', async () => {
    song.duration = formatDuration(tmp.duration);
    await saveSong(song);
    renderAll();
  });
  tmp.load();
}

// ─── PLAYBACK ─────────────────────────────────────────────
function playSong(id) {
  const song = library.find(s => s.id === id);
  if (!song) return;
  queue = [...library];
  queueIndex = queue.findIndex(s => s.id === id);
  loadAndPlay(song);
}

function playSongFromList(id, source) {
  const song = library.find(s => s.id === id);
  if (!song) return;
  if (source && source.startsWith('playlist_')) {
    const pid = parseInt(source.split('_')[1]);
    const pl  = playlists.find(p => p.id === pid);
    if (pl) {
      queue = pl.songIds.map(sid => library.find(s => s.id === sid)).filter(Boolean);
      queueIndex = queue.findIndex(s => s.id === id);
      loadAndPlay(song);
      return;
    }
  }
  queue = [...library];
  queueIndex = queue.findIndex(s => s.id === id);
  loadAndPlay(song);
}

function loadAndPlay(song) {
  if (!song.url) {
    if (song.blob) { song.url = URL.createObjectURL(song.blob); }
    else { showToast('audio unavailable — try re-uploading'); return; }
  }
  audio.src = song.url;
  audio.play();
  updatePlayerUI(song);
  renderAll();
}

function updatePlayerUI(song) {
  document.getElementById('playerTitle').textContent  = song.title;
  document.getElementById('playerArtist').textContent = song.artist || 'Unknown Artist';
  const artEl = document.getElementById('playerArt');
  artEl.innerHTML = song.cover
    ? `<img src="${escHtml(song.cover)}" alt="" onerror="this.style.display='none'"/>`
    : musicIconStr(22);
  document.getElementById('playIcon').style.display  = 'none';
  document.getElementById('pauseIcon').style.display = '';
  document.getElementById('likeBtn').classList.toggle('liked', !!song.liked);
  document.title = `${song.title} — mezzo-piano`;
}

function togglePlay() {
  if (!audio.src) return;
  if (audio.paused) {
    audio.play();
    document.getElementById('playIcon').style.display  = 'none';
    document.getElementById('pauseIcon').style.display = '';
  } else {
    audio.pause();
    document.getElementById('playIcon').style.display  = '';
    document.getElementById('pauseIcon').style.display = 'none';
  }
}

function nextTrack() {
  if (!queue.length) return;
  if (repeatMode === 'one') { audio.currentTime = 0; audio.play(); return; }
  queueIndex = shuffle
    ? Math.floor(Math.random() * queue.length)
    : (queueIndex + 1) % queue.length;
  loadAndPlay(queue[queueIndex]);
}

function prevTrack() {
  if (!queue.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  queueIndex = (queueIndex - 1 + queue.length) % queue.length;
  loadAndPlay(queue[queueIndex]);
}

function onTrackEnd() {
  if (repeatMode === 'one') { audio.currentTime = 0; audio.play(); return; }
  if (repeatMode === 'all' || queueIndex < queue.length - 1 || shuffle) nextTrack();
  else {
    document.getElementById('playIcon').style.display  = '';
    document.getElementById('pauseIcon').style.display = 'none';
    document.title = 'Mezzo-Piano | Find your dynamic';
  }
}

function toggleShuffle() {
  shuffle = !shuffle;
  document.getElementById('shuffleBtn').classList.toggle('active', shuffle);
  showToast(shuffle ? 'shuffle on' : 'shuffle off');
}

function toggleRepeat() {
  const modes = ['none','all','one'];
  repeatMode = modes[(modes.indexOf(repeatMode)+1) % 3];
  const btn = document.getElementById('repeatBtn');
  btn.classList.toggle('active', repeatMode !== 'none');
  btn.title = repeatMode === 'none' ? 'Repeat' : repeatMode === 'all' ? 'Repeat: All' : 'Repeat: One';
  showToast(repeatMode === 'none' ? 'repeat off' : repeatMode === 'all' ? 'repeat all' : 'repeat one');
}

async function toggleLike() {
  const s = getCurrentSong();
  if (!s) return;
  s.liked = !s.liked;
  document.getElementById('likeBtn').classList.toggle('liked', s.liked);
  await saveSong(s);
  showToast(s.liked ? `liked "${s.title}"` : 'removed from liked');
}

function getCurrentSong() {
  return (queueIndex >= 0 && queueIndex < queue.length) ? queue[queueIndex] : null;
}
function isCurrentSong(id) {
  const c = getCurrentSong();
  return c && c.id === id && !audio.paused;
}

// ─── PROGRESS ─────────────────────────────────────────────
function updateProgress() {
  const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressThumb').style.left = pct + '%';
  document.getElementById('currentTime').textContent  = formatDuration(audio.currentTime);
}
async function onMetaLoaded() {
  document.getElementById('totalTime').textContent = formatDuration(audio.duration);
  const s = getCurrentSong();
  if (s && !s.duration) {
    s.duration = formatDuration(audio.duration);
    await saveSong(s);
  }
}
function seekTo(e) {
  const rect = document.getElementById('progressContainer').getBoundingClientRect();
  const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  if (audio.duration) audio.currentTime = pct * audio.duration;
}

// ─── VOLUME ───────────────────────────────────────────────
function setVolume(v) {
  audio.volume = v / 100;
  document.getElementById('volumeSlider').value = v;
}
function toggleMute() {
  audio.muted = !audio.muted;
  document.getElementById('muteBtn').querySelector('svg').style.opacity = audio.muted ? '0.3' : '1';
}

// ─── CONTEXT MENU ─────────────────────────────────────────
function showCtxMenu(e, songId, source) {
  e.preventDefault(); e.stopPropagation();
  ctxSongId = songId; ctxSource = source || 'library';
  const m = document.getElementById('contextMenu');
  m.style.display = 'block';
  m.style.left = Math.min(e.clientX, window.innerWidth  - 190) + 'px';
  m.style.top  = Math.min(e.clientY, window.innerHeight - 170) + 'px';
}
function hideContextMenu() { document.getElementById('contextMenu').style.display = 'none'; }
function ctxPlay() { hideContextMenu(); playSong(ctxSongId); }
function ctxAddToQueue() {
  hideContextMenu();
  const s = library.find(s => s.id === ctxSongId);
  if (!s) return;
  queue.splice(queueIndex + 1, 0, s);
  showToast(`"${s.title}" added to queue`);
}

async function ctxDelete() {
  hideContextMenu();
  const song = library.find(s => s.id === ctxSongId);
  if (!song) return;

  if (ctxSource && ctxSource.startsWith('playlist_')) {
    const pid = parseInt(ctxSource.split('_')[1]);
    const pl  = playlists.find(p => p.id === pid);
    if (pl) {
      pl.songIds = pl.songIds.filter(id => id !== ctxSongId);
      await save();
      renderAll();
      showToast('removed from playlist');
      return;
    }
  }

  if (!confirm(`permanently delete "${song.title}" from your library?`)) return;
  if (song.url) URL.revokeObjectURL(song.url);
  library = library.filter(s => s.id !== ctxSongId);
  playlists.forEach(p => { p.songIds = p.songIds.filter(id => id !== ctxSongId); });
  await dbDelete('songs', ctxSongId);
  await save();
  if (getCurrentSong()?.id === ctxSongId) nextTrack();
  renderAll();
  showToast(`"${song.title}" deleted`);
}

// ─── PLAYLIST PICKER ──────────────────────────────────────
function showPlaylistPicker() {
  hideContextMenu();
  const list = document.getElementById('playlistPickerList');
  list.innerHTML = playlists.length
    ? playlists.map(p => `<div class="picker-item" onclick="addToPlaylist(${p.id})">${escHtml(p.name)}</div>`).join('')
    : `<div style="color:var(--text3);font-size:.82rem;padding:.5rem">no playlists yet.</div>`;
  document.getElementById('playlistPicker').classList.add('open');
}
function closePlaylistPicker(e) {
  if (!e || e.target === document.getElementById('playlistPicker') || !e.target.closest('.modal'))
    document.getElementById('playlistPicker').classList.remove('open');
}
async function addToPlaylist(pid) {
  document.getElementById('playlistPicker').classList.remove('open');
  const p = playlists.find(p => p.id === pid);
  if (!p) return;
  if (p.songIds.includes(ctxSongId)) { showToast('already in playlist'); return; }
  p.songIds.push(ctxSongId);
  await save();
  renderSidebar();
  showToast(`added to "${p.name}"`);
}

// ─── TOAST ────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

// ─── HELPERS ──────────────────────────────────────────────
function formatDuration(s) {
  if (!s || isNaN(s)) return '0:00';
  return `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
}
function formatBytes(b) {
  return b < 1048576 ? (b/1024).toFixed(0)+' KB' : (b/1048576).toFixed(1)+' MB';
}
function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function musicIcon(size=24) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" stroke="var(--accent)" fill="none" stroke-width="1.5" stroke-linecap="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
}
function musicIconStr(size=22) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" stroke="var(--accent)" fill="none" stroke-width="1.5" stroke-linecap="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
}
function eqBars() {
  return `<span class="eq-bars"><span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span></span>`;
}

// ============================================================================
//  Data layer
//  Invidious / Piped public instances are effectively dead in 2026 (down, CORS
//  blocked, rate limited), so mytube now pulls the video list straight from
//  YouTube's public RSS feed and plays audio through the official YouTube
//  IFrame Player API. Both work reliably from a static GitHub Pages host.
// ============================================================================

// CORS proxies tried in order (first success wins). They only relay a GET and
// echo the body back with permissive CORS headers, so no API key is needed.
const CORS_PROXIES = [
  (url) => `https://proxy.cors.sh/${url}`,
  (url) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

// Fetch a URL through the CORS proxy chain, returning the raw response text.
async function fetchViaProxy(targetUrl) {
  let lastError = null;
  for (const buildProxyUrl of CORS_PROXIES) {
    const proxyUrl = buildProxyUrl(targetUrl);
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 12000); // 12s timeout
      const response = await fetch(proxyUrl, { signal: controller.signal });
      clearTimeout(id);

      if (response.ok) {
        const text = await response.text();
        if (text && text.length > 50) return text;
      }
      console.warn(`Proxy returned no usable data: ${proxyUrl} (status ${response.status})`);
    } catch (e) {
      lastError = e;
      console.warn(`Proxy failed: ${proxyUrl}`, e.message);
    }
  }
  throw new Error(`모든 프록시 요청 실패${lastError ? ` (${lastError.message})` : ''}`);
}

// Format an ISO date string into a Korean relative label ("3일 전" etc.).
function formatPublished(isoDate) {
  if (!isoDate) return '';
  const then = new Date(isoDate);
  if (isNaN(then)) return '';
  const diffSec = Math.floor((Date.now() - then.getTime()) / 1000);
  const units = [
    ['년', 31536000],
    ['개월', 2592000],
    ['주', 604800],
    ['일', 86400],
    ['시간', 3600],
    ['분', 60],
  ];
  for (const [label, secs] of units) {
    const v = Math.floor(diffSec / secs);
    if (v >= 1) return `${v}${label} 전`;
  }
  return '방금 전';
}

// Fetch a channel's recent videos via the YouTube RSS feed (no API key needed).
async function fetchChannelVideos(channelId) {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const xmlText = await fetchViaProxy(feedUrl);

  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('RSS 피드 파싱 실패');
  }

  const channelName = doc.querySelector('feed > author > name')?.textContent || '';
  const entries = Array.from(doc.getElementsByTagName('entry'));

  return entries
    .map((entry) => {
      // Namespaced <yt:videoId> — read by qualified tag name with a regex fallback.
      const videoId =
        entry.getElementsByTagName('yt:videoId')[0]?.textContent ||
        (entry.getElementsByTagName('id')[0]?.textContent || '').replace('yt:video:', '');
      const title = entry.getElementsByTagName('title')[0]?.textContent || '';
      const published = entry.getElementsByTagName('published')[0]?.textContent || '';
      return {
        videoId,
        title,
        author: channelName,
        publishedText: formatPublished(published),
        // Keep the Invidious-style shape the renderer already expects.
        videoThumbnails: [
          { url: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` },
          { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` },
        ],
      };
    })
    .filter((v) => v.videoId);
}

// Resolve arbitrary user input (UC id / URL / @handle / name) to channel info.
//
// A channel ID (UC...) is resolved through the YouTube RSS feed — the same small,
// reliable endpoint the video list uses — so pasting an ID always works. Only
// handles / custom URLs / names require scraping the (large, flaky) channel page
// to discover the ID first; we then confirm the name via RSS as well.
async function resolveChannel(input) {
  const query = input.trim();
  if (!query) throw new Error('채널 ID 또는 URL을 입력하세요.');

  // 1) Pull a channel ID straight out of the input if one is present
  //    (raw "UC..." or a "/channel/UC..." URL).
  let authorId = (query.match(/(UC[0-9A-Za-z_-]{22})/) || [])[1] || null;

  // 2) No direct ID → scrape the channel page to discover it.
  let html = null;
  if (!authorId) {
    let targetUrl;
    if (query.startsWith('http')) {
      targetUrl = query;
    } else {
      const handle = query.startsWith('@') ? query : `@${query.replace(/^@/, '')}`;
      targetUrl = `https://www.youtube.com/${handle}`;
    }

    html = await fetchViaProxy(targetUrl);
    authorId =
      (html.match(/"(?:externalId|channelId)":"(UC[0-9A-Za-z_-]{22})"/) || [])[1] ||
      (html.match(/channel_id=(UC[0-9A-Za-z_-]{22})/) || [])[1] ||
      (html.match(/\/channel\/(UC[0-9A-Za-z_-]{22})/) || [])[1] ||
      null;
    if (!authorId) {
      throw new Error('채널 ID를 찾지 못했습니다. 채널 ID(UC...)를 직접 입력해 보세요.');
    }
  }

  // 3) Get the channel name (and verify the channel exists) via the RSS feed.
  let author = query;
  let authorThumbnails = null;
  try {
    const feedXml = await fetchViaProxy(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${authorId}`
    );
    const doc = new DOMParser().parseFromString(feedXml, 'application/xml');
    const rssName = doc.querySelector('feed > author > name')?.textContent;
    if (rssName) author = rssName;
  } catch (e) {
    console.warn('RSS 채널명 조회 실패 — HTML 값으로 대체', e);
  }

  // 4) If we scraped the page, enrich name/avatar from it (avatar isn't in RSS).
  if (html) {
    const rawName =
      (html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1] ||
      (html.match(/"title":"([^"]+)","navigationEndpoint"/) || [])[1];
    if (rawName) author = decodeHtmlEntities(rawName);

    const avatarRaw = (html.match(/"avatar":\{"thumbnails":\[\{"url":"([^"]+)"/) || [])[1];
    if (avatarRaw) {
      authorThumbnails = [{ url: avatarRaw.replace(/\\u002F/gi, '/').replace(/\\\//g, '/') }];
    }
  }

  return { authorId, author, authorThumbnails };
}

// Minimal HTML-entity decoder for scraped channel titles.
function decodeHtmlEntities(str) {
  if (!str) return str;
  const ta = document.createElement('textarea');
  ta.innerHTML = str;
  return ta.value;
}

// ============================================================================
//  App State
// ============================================================================
const state = {
  subscribedChannels: [], // { author, authorId, authorThumbnails }
  currentPlaylist: [],    // [{ videoId, title, author, publishedText, videoThumbnails }]
  currentTrackIndex: -1,
  isPlaying: false,
  activeTab: 'channels',  // 'channels' or 'tracks'
  engine: null,           // 'server' (<audio>) or 'iframe' (YouTube embed)
};

// Personal background-playback server URL (empty = use YouTube embed fallback).
function getServerUrl() {
  return (localStorage.getItem('mytube_server_url') || '').trim().replace(/\/+$/, '');
}

// ============================================================================
//  DOM Elements
// ============================================================================
const playBtn = document.getElementById('play-btn');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');
const trackTitle = document.getElementById('track-title');
const trackChannel = document.getElementById('track-channel');
const currentTimeEl = document.getElementById('current-time');
const durationTimeEl = document.getElementById('duration-time');
const progressBar = document.getElementById('progress-bar');
const progressBarContainer = document.getElementById('progress-bar-container');
const audioPlayer = document.getElementById('audio-player');

const tabChannelsBtn = document.getElementById('tab-channels-btn');
const tabTracksBtn = document.getElementById('tab-tracks-btn');
const tabChannels = document.getElementById('tab-channels');
const tabTracks = document.getElementById('tab-tracks');
const channelsList = document.getElementById('channels-list');
const tracksList = document.getElementById('tracks-list');
const noChannelsMsg = document.getElementById('no-channels-msg');
const noTracksMsg = document.getElementById('no-tracks-msg');

const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const channelSearchInput = document.getElementById('channel-search-input');
const addChannelBtn = document.getElementById('add-channel-btn');
const settingsChannelsList = document.getElementById('settings-channels-list');
const settingsCount = document.getElementById('settings-count');
const serverUrlInput = document.getElementById('server-url-input');
const saveServerBtn = document.getElementById('save-server-btn');
const serverStatus = document.getElementById('server-status');

// ============================================================================
//  YouTube IFrame Player (audio playback engine)
// ============================================================================
let ytPlayer = null;
let ytReady = false;
let pendingVideoId = null;   // videoId requested before the player finished loading
let progressTimer = null;

// Called automatically by the YouTube IFrame API once it finishes loading.
window.onYouTubeIframeAPIReady = function () {
  ytPlayer = new YT.Player('yt-player', {
    height: '1',
    width: '1',
    playerVars: {
      autoplay: 0,
      controls: 0,
      disablekb: 1,
      playsinline: 1,
      rel: 0,
    },
    events: {
      onReady: () => {
        ytReady = true;
        if (pendingVideoId) {
          const id = pendingVideoId;
          pendingVideoId = null;
          ytPlayer.loadVideoById(id);
        }
      },
      onStateChange: onPlayerStateChange,
      onError: onPlayerError,
    },
  });
};

function onPlayerStateChange(e) {
  // YT.PlayerState: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
  if (e.data === YT.PlayerState.ENDED) {
    nextTrack();
  } else if (e.data === YT.PlayerState.PLAYING) {
    state.isPlaying = true;
    updatePlayButton();
    startProgressTimer();
    document.querySelector('.player-panel').classList.add('playing');
    // Restore the real title once playback actually starts.
    const track = state.currentPlaylist[state.currentTrackIndex];
    if (track) trackTitle.textContent = track.title;
  } else if (e.data === YT.PlayerState.PAUSED) {
    state.isPlaying = false;
    updatePlayButton();
    document.querySelector('.player-panel').classList.remove('playing');
  }
}

function onPlayerError(e) {
  // 100/101/150 = video unavailable or embedding disabled → skip to the next one.
  console.error('YT Player error:', e.data);
  trackTitle.textContent = '재생 불가한 영상입니다. 다음 곡으로 넘어갑니다';
  setTimeout(() => nextTrack(), 1500);
}

function startProgressTimer() {
  clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    if (!ytPlayer || typeof ytPlayer.getDuration !== 'function') return;
    const cur = ytPlayer.getCurrentTime() || 0;
    const dur = ytPlayer.getDuration() || 0;
    currentTimeEl.textContent = formatTime(cur);
    durationTimeEl.textContent = formatTime(dur);
    if (dur > 0) progressBar.style.width = `${(cur / dur) * 100}%`;
  }, 500);
}

// ============================================================================
//  <audio> engine (personal server — background/lock-screen playback)
// ============================================================================
audioPlayer.addEventListener('play', () => {
  state.isPlaying = true;
  updatePlayButton();
  document.querySelector('.player-panel').classList.add('playing');
  const track = state.currentPlaylist[state.currentTrackIndex];
  if (track) trackTitle.textContent = track.title;
});

audioPlayer.addEventListener('pause', () => {
  if (state.engine !== 'server') return;
  state.isPlaying = false;
  updatePlayButton();
  document.querySelector('.player-panel').classList.remove('playing');
});

audioPlayer.addEventListener('ended', () => {
  if (state.engine === 'server') nextTrack();
});

audioPlayer.addEventListener('timeupdate', () => {
  if (state.engine !== 'server') return;
  const cur = audioPlayer.currentTime || 0;
  const dur = audioPlayer.duration || 0;
  currentTimeEl.textContent = formatTime(cur);
  if (!isNaN(dur) && dur > 0) {
    durationTimeEl.textContent = formatTime(dur);
    progressBar.style.width = `${(cur / dur) * 100}%`;
  }
});

// Server unreachable / stream failed → fall back to the YouTube embed.
audioPlayer.addEventListener('error', () => {
  if (state.engine !== 'server') return; // ignore errors from clearing src
  console.warn('Server playback failed — falling back to YouTube embed.');
  const track = state.currentPlaylist[state.currentTrackIndex];
  if (track) {
    trackTitle.textContent = '서버 재생 실패 — 유튜브로 전환 중...';
    playViaIframe(track);
  }
});

// ============================================================================
//  Helpers
// ============================================================================
function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

function formatTime(seconds) {
  if (isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

// ============================================================================
//  Subscribed channels (LocalStorage)
// ============================================================================
function loadSubscribedChannels() {
  const data = localStorage.getItem('mytube_channels');
  if (data) {
    state.subscribedChannels = JSON.parse(data);
  } else {
    // Default channel for first-run demonstration (하이파이브: LA 최고 예능라디오).
    state.subscribedChannels = [
      {
        author: '하이파이브 : LA 최고 예능라디오',
        authorId: 'UCRstLhO5i-Qg5W0VFefuKSw',
        authorThumbnails: [
          {
            url: 'https://yt3.ggpht.com/Iv6GDZpjOzkRddAEn8AzsbsI_iZOUlp08N_7D_BF-p-nou43KVVYV4xpbHPZFUPCKFkiFPBq=s176-c-k-c0x00ffffff-no-rj-mo',
          },
        ],
      },
    ];
    localStorage.setItem('mytube_channels', JSON.stringify(state.subscribedChannels));
  }
  updateChannelsUI();
}

function saveSubscribedChannels() {
  localStorage.setItem('mytube_channels', JSON.stringify(state.subscribedChannels));
  updateChannelsUI();
}

function updateChannelsUI() {
  channelsList.innerHTML = '';
  settingsChannelsList.innerHTML = '';

  const count = state.subscribedChannels.length;
  settingsCount.textContent = count;

  if (count === 0) {
    noChannelsMsg.style.display = 'flex';
  } else {
    noChannelsMsg.style.display = 'none';

    state.subscribedChannels.forEach((channel) => {
      const thumb = channel.authorThumbnails
        ? channel.authorThumbnails[channel.authorThumbnails.length - 1].url
        : 'https://images.unsplash.com/photo-1614680376593-902f74fa0d41?w=100';

      // Main UI channel card
      const card = document.createElement('div');
      card.className = 'channel-card';
      card.innerHTML = `
        <img src="${thumb}" alt="${channel.author}" referrerpolicy="no-referrer">
        <h4>${channel.author}</h4>
      `;
      card.addEventListener('click', () => loadChannelVideos(channel.authorId));
      channelsList.appendChild(card);

      // Settings modal list item
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="settings-ch-info">
          <img src="${thumb}" alt="${channel.author}" referrerpolicy="no-referrer">
          <span class="settings-ch-name">${channel.author}</span>
        </div>
        <button class="delete-btn" aria-label="삭제">
          <i data-lucide="trash-2"></i>
        </button>
      `;
      li.querySelector('.delete-btn').addEventListener('click', () => {
        state.subscribedChannels = state.subscribedChannels.filter(
          (c) => c.authorId !== channel.authorId
        );
        saveSubscribedChannels();
      });
      settingsChannelsList.appendChild(li);
    });
  }
  refreshIcons();
}

// ============================================================================
//  Playlist / tracks
// ============================================================================
async function loadChannelVideos(channelId) {
  try {
    switchTab('tracks');
    tracksList.innerHTML = '<div class="empty-msg"><p>영상을 불러오는 중...</p></div>';
    noTracksMsg.style.display = 'none';

    const videos = await fetchChannelVideos(channelId);

    if (videos.length > 0) {
      state.currentPlaylist = videos;
      renderTracks();
    } else {
      tracksList.innerHTML = '<div class="empty-msg"><p>동영상이 존재하지 않습니다.</p></div>';
    }
  } catch (e) {
    console.error(e);
    tracksList.innerHTML =
      '<div class="empty-msg"><p>목록을 가져오지 못했습니다. 다시 시도해 주세요.</p></div>';
  }
}

function renderTracks() {
  tracksList.innerHTML = '';
  state.currentPlaylist.forEach((track, index) => {
    const isCurrent = state.currentTrackIndex === index;
    const item = document.createElement('div');
    item.className = `track-item ${isCurrent ? 'playing' : ''}`;

    const thumb = track.videoThumbnails
      ? track.videoThumbnails[0].url
      : `https://i.ytimg.com/vi/${track.videoId}/mqdefault.jpg`;

    item.innerHTML = `
      <img src="${thumb}" alt="${track.title}" referrerpolicy="no-referrer">
      <div class="track-item-info">
        <div class="track-item-title">${track.title}</div>
        <div class="track-item-date">${track.publishedText || ''}</div>
      </div>
    `;
    item.addEventListener('click', () => playTrack(index));
    tracksList.appendChild(item);
  });
}

// ============================================================================
//  Playback
// ============================================================================
function playTrack(index) {
  if (index < 0 || index >= state.currentPlaylist.length) return;
  state.currentTrackIndex = index;
  const track = state.currentPlaylist[index];

  // Update mini player info
  trackTitle.textContent = track.title;
  trackChannel.textContent = track.author || '';
  const thumb = track.videoThumbnails
    ? track.videoThumbnails[track.videoThumbnails.length - 1].url
    : `https://i.ytimg.com/vi/${track.videoId}/hqdefault.jpg`;

  renderTracks();
  setupMediaSession(track, thumb);

  // A personal server enables true background playback via <audio>; otherwise
  // fall back to the YouTube embed (foreground only).
  if (getServerUrl()) {
    playViaServer(track);
  } else {
    playViaIframe(track);
  }
}

// Stream audio from the personal server through the <audio> element.
function playViaServer(track) {
  state.engine = 'server';
  clearInterval(progressTimer);
  try {
    if (ytPlayer && ytReady) ytPlayer.stopVideo();
  } catch (e) { /* ignore */ }

  audioPlayer.src = `${getServerUrl()}/audio/${track.videoId}`;
  audioPlayer.load();
  audioPlayer.play().catch((err) => console.warn('audio play() rejected:', err));
}

// Play through the hidden YouTube IFrame player (no-setup fallback).
function playViaIframe(track) {
  state.engine = 'iframe';
  try {
    audioPlayer.pause();
    audioPlayer.removeAttribute('src');
    audioPlayer.load();
  } catch (e) { /* ignore */ }

  if (!ytReady || !ytPlayer) {
    trackTitle.textContent = '플레이어 로딩 중... ' + track.title;
    pendingVideoId = track.videoId;
    return;
  }
  ytPlayer.loadVideoById(track.videoId); // auto-plays
}

// Media Session Setup (lockscreen / system notification controls)
function setupMediaSession(track, thumbnail) {
  if (!('mediaSession' in navigator)) return;

  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.author,
    album: 'mytube Radio',
    artwork: [{ src: thumbnail, sizes: '512x512', type: 'image/jpeg' }],
  });

  navigator.mediaSession.setActionHandler('play', resumePlayback);
  navigator.mediaSession.setActionHandler('pause', pausePlayback);
  navigator.mediaSession.setActionHandler('previoustrack', () => prevTrack());
  navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack());
}

function nextTrack() {
  if (state.currentPlaylist.length === 0) return;
  let nextIdx = state.currentTrackIndex + 1;
  if (nextIdx >= state.currentPlaylist.length) nextIdx = 0; // loop playlist
  playTrack(nextIdx);
}

function prevTrack() {
  if (state.currentPlaylist.length === 0) return;
  let prevIdx = state.currentTrackIndex - 1;
  if (prevIdx < 0) prevIdx = state.currentPlaylist.length - 1; // loop to end
  playTrack(prevIdx);
}

function updatePlayButton() {
  const icon = playBtn.querySelector('.play-icon');
  icon.setAttribute('data-lucide', state.isPlaying ? 'pause' : 'play');
  refreshIcons();
}

// Engine-aware resume / pause used by the play button and media session.
function resumePlayback() {
  if (state.engine === 'server') audioPlayer.play();
  else if (ytPlayer) ytPlayer.playVideo();
}

function pausePlayback() {
  if (state.engine === 'server') audioPlayer.pause();
  else if (ytPlayer) ytPlayer.pauseVideo();
}

// ============================================================================
//  Event listeners
// ============================================================================
playBtn.addEventListener('click', async () => {
  // Nothing selected yet → load the first subscribed channel and start playing.
  if (state.currentTrackIndex === -1) {
    if (state.currentPlaylist.length === 0) {
      if (state.subscribedChannels.length > 0) {
        trackTitle.textContent = '채널 목록 로딩 중...';
        await loadChannelVideos(state.subscribedChannels[0].authorId);
      } else {
        alert('구독 중인 채널이 없습니다. 설정에서 채널을 추가해 주세요.');
        return;
      }
    }
    if (state.currentPlaylist.length > 0) playTrack(0);
    return;
  }

  if (state.isPlaying) pausePlayback();
  else resumePlayback();
});

// Seek by clicking the progress bar
progressBarContainer.addEventListener('click', (e) => {
  const width = progressBarContainer.clientWidth;
  if (state.engine === 'server') {
    const duration = audioPlayer.duration;
    if (duration > 0) audioPlayer.currentTime = (e.offsetX / width) * duration;
  } else if (ytPlayer && typeof ytPlayer.getDuration === 'function') {
    const duration = ytPlayer.getDuration();
    if (duration > 0) ytPlayer.seekTo((e.offsetX / width) * duration, true);
  }
});

prevBtn.addEventListener('click', prevTrack);
nextBtn.addEventListener('click', nextTrack);

// ============================================================================
//  Tabs
// ============================================================================
function switchTab(tabName) {
  state.activeTab = tabName;
  if (tabName === 'channels') {
    tabChannelsBtn.classList.add('active');
    tabTracksBtn.classList.remove('active');
    tabChannels.classList.add('active');
    tabTracks.classList.remove('active');
  } else {
    tabChannelsBtn.classList.remove('active');
    tabTracksBtn.classList.add('active');
    tabChannels.classList.remove('active');
    tabTracks.classList.add('active');
  }
}

tabChannelsBtn.addEventListener('click', () => switchTab('channels'));
tabTracksBtn.addEventListener('click', () => switchTab('tracks'));

// ============================================================================
//  Settings modal
// ============================================================================
settingsBtn.addEventListener('click', () => settingsModal.classList.add('active'));
closeSettingsBtn.addEventListener('click', () => settingsModal.classList.remove('active'));
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) settingsModal.classList.remove('active');
});

// Add channel by ID / URL / @handle / name
addChannelBtn.addEventListener('click', async () => {
  const query = channelSearchInput.value.trim();
  if (!query) return;

  addChannelBtn.disabled = true;
  addChannelBtn.textContent = '검색중';

  try {
    const channelData = await resolveChannel(query);

    if (channelData && channelData.authorId) {
      const exists = state.subscribedChannels.some((c) => c.authorId === channelData.authorId);
      if (!exists) {
        state.subscribedChannels.push({
          author: channelData.author,
          authorId: channelData.authorId,
          authorThumbnails: channelData.authorThumbnails,
        });
        saveSubscribedChannels();
        channelSearchInput.value = '';
        alert(`${channelData.author} 채널이 구독 목록에 추가되었습니다.`);
      } else {
        alert('이미 추가된 채널입니다.');
      }
    } else {
      alert('채널을 찾을 수 없습니다. 정확한 ID, URL 또는 채널 핸들(@)을 입력해주세요.');
    }
  } catch (err) {
    console.error(err);
    alert(`채널 정보 탐색 실패: ${err.message}\n\n채널 ID(UC...)를 직접 입력하면 가장 확실합니다.`);
  } finally {
    addChannelBtn.disabled = false;
    addChannelBtn.textContent = '추가';
  }
});

// Save / test the personal background-playback server URL
saveServerBtn.addEventListener('click', async () => {
  const url = serverUrlInput.value.trim().replace(/\/+$/, '');
  localStorage.setItem('mytube_server_url', url);

  if (!url) {
    serverStatus.textContent = '서버 없음 — 유튜브 임베드로 재생합니다.';
    serverStatus.className = 'server-status';
    return;
  }

  serverStatus.textContent = '연결 확인 중...';
  serverStatus.className = 'server-status';
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(`${url}/health`, { signal: controller.signal });
    clearTimeout(id);
    if (!r.ok) throw new Error('bad status');
    serverStatus.textContent = '✓ 서버 연결됨 — 백그라운드 재생이 켜졌습니다.';
    serverStatus.className = 'server-status ok';
  } catch (e) {
    serverStatus.textContent = '✗ 서버에 연결할 수 없습니다. 주소와 서버 상태를 확인하세요.';
    serverStatus.className = 'server-status err';
  }
});

// ============================================================================
//  Service Worker
// ============================================================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .then((reg) => console.log('ServiceWorker registered with scope: ', reg.scope))
      .catch((err) => console.error('ServiceWorker registration failed: ', err));
  });
}

// ============================================================================
//  Init
// ============================================================================
loadSubscribedChannels();
serverUrlInput.value = getServerUrl();
refreshIcons();

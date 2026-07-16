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

// Fetch a URL through the personal server when one is configured, else through
// the public CORS proxy chain. The server (residential IP, own CORS) is far more
// reliable — public proxies are frequently rate limited or down.
async function fetchViaProxy(targetUrl) {
  const server = getServerUrl();
  if (server) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 30000);
      const res = await fetch(`${server}/fetch?url=${encodeURIComponent(targetUrl)}`, {
        signal: controller.signal,
      });
      clearTimeout(id);
      if (res.ok) {
        const text = await res.text();
        if (text && text.length > 50) return text;
      }
      console.warn(`서버 /fetch 실패 (${res.status}) — 공개 프록시로 폴백`);
    } catch (e) {
      console.warn('서버 /fetch 오류 — 공개 프록시로 폴백:', e.message);
    }
  }
  return fetchViaPublicProxy(targetUrl);
}

// Fetch a URL through the public CORS proxy chain, returning the raw response text.
async function fetchViaPublicProxy(targetUrl) {
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

// POST-capable proxies (for YouTube's internal continuation API, which only
// answers POST). Fewer public proxies forward a POST body, so this list is
// separate from the GET chain and may fail — "더 보기" degrades gracefully.
const CORS_PROXIES_POST = [
  (url) => `https://proxy.cors.sh/${url}`,
  (url) => `https://thingproxy.freeboard.io/fetch/${url}`,
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
];

// POST a JSON body through the POST proxy chain and return the parsed JSON.
async function fetchJsonViaProxyPost(targetUrl, bodyObj) {
  const payload = JSON.stringify(bodyObj);
  let lastError = null;
  for (const buildProxyUrl of CORS_PROXIES_POST) {
    const proxyUrl = buildProxyUrl(targetUrl);
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 15000);
      const response = await fetch(proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: controller.signal,
      });
      clearTimeout(id);
      if (response.ok) {
        const text = await response.text();
        if (text && text.length > 50) {
          try {
            return JSON.parse(text);
          } catch (e) {
            console.warn(`POST proxy returned non-JSON: ${proxyUrl}`);
          }
        }
      }
    } catch (e) {
      lastError = e;
      console.warn(`POST proxy failed: ${proxyUrl}`, e.message);
    }
  }
  throw new Error(`continuation 요청 실패${lastError ? ` (${lastError.message})` : ''}`);
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

// ---------------------------------------------------------------------------
//  "더 보기" — older videos via YouTube's internal continuation API
//  RSS only exposes the latest ~15 videos, so to page further back we scrape
//  the channel /videos page once (for the first continuation token + api key),
//  then POST to youtubei/v1/browse for each additional batch.
// ---------------------------------------------------------------------------

// Build a track object in the shape the renderer expects.
function makeTrack(videoId, title, publishedText, channelName) {
  return {
    videoId,
    title,
    author: channelName,
    publishedText,
    videoThumbnails: [
      { url: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` },
      { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` },
    ],
  };
}

// Pull the "published" label out of a lockupViewModel's metadata rows. The
// view-count and date parts carry no icon, so we pick the part that reads like
// a relative date, falling back to the last part (date is listed last).
function publishedFromLockup(meta) {
  try {
    const rows = meta.metadata.contentMetadataViewModel.metadataRows;
    const texts = [];
    for (const row of rows) {
      for (const part of row.metadataParts || []) {
        if (part.text && part.text.content) texts.push(part.text.content);
      }
    }
    if (texts.length === 0) return '';
    const dateLike = texts.find((t) =>
      /전|ago|분|시간|일|주|개월|년|hour|day|week|month|year/.test(t)
    );
    return dateLike || texts[texts.length - 1];
  } catch (e) {
    return '';
  }
}

// Recursively pull video items out of any parsed YouTube response. Handles both
// the current lockupViewModel format (channel Videos tab) and the legacy
// videoRenderer format, deduped by id.
function extractTracksFromResponse(root, channelName) {
  const out = [];
  const seen = new Set();
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const lvm = node.lockupViewModel;
    if (lvm && lvm.contentId && lvm.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' && !seen.has(lvm.contentId)) {
      seen.add(lvm.contentId);
      const meta = lvm.metadata && lvm.metadata.lockupMetadataViewModel;
      const title = (meta && meta.title && meta.title.content) || '';
      out.push(makeTrack(lvm.contentId, title, publishedFromLockup(meta), channelName));
    }

    const vr = node.videoRenderer;
    if (vr && vr.videoId && !seen.has(vr.videoId)) {
      seen.add(vr.videoId);
      const title =
        (vr.title && vr.title.runs && vr.title.runs[0] && vr.title.runs[0].text) ||
        (vr.title && vr.title.simpleText) ||
        '';
      const published = (vr.publishedTimeText && vr.publishedTimeText.simpleText) || '';
      out.push(makeTrack(vr.videoId, title, published, channelName));
    }

    for (const key in node) walk(node[key]);
  })(root);
  return out;
}

// Find the next continuation token anywhere in a parsed YouTube response.
function findContinuationToken(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.continuationCommand && node.continuationCommand.token) {
    return node.continuationCommand.token;
  }
  for (const key in node) {
    const token = findContinuationToken(node[key]);
    if (token) return token;
  }
  return null;
}

// First page: scrape the channel /videos HTML for the initial video batch plus
// the continuation token / api key / client version needed to page further.
async function initMorePagination(channelId, channelName) {
  const html = await fetchViaProxy(`https://www.youtube.com/channel/${channelId}/videos`);

  const apiKey = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1] || null;
  const clientVersion =
    (html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/) || [])[1] ||
    (html.match(/"clientVersion":"([\d.]+)"/) || [])[1] ||
    null;

  const dataStr =
    (html.match(/var ytInitialData\s*=\s*(\{.+?\})\s*;\s*<\/script>/s) || [])[1] ||
    (html.match(/ytInitialData\s*=\s*(\{.+?\})\s*;\s*<\/script>/s) || [])[1] ||
    (html.match(/window\["ytInitialData"\]\s*=\s*(\{.+?\})\s*;/s) || [])[1];

  let videos = [];
  let token = null;
  if (dataStr) {
    try {
      const data = JSON.parse(dataStr);
      videos = extractTracksFromResponse(data, channelName);
      token = findContinuationToken(data);
    } catch (e) {
      console.warn('ytInitialData 파싱 실패', e);
    }
  }

  const moreCtx = apiKey && clientVersion && token
    ? { channelId, apiKey, clientVersion, token }
    : null;
  return { videos, moreCtx };
}

// Subsequent pages: POST the continuation token to the internal browse API.
// YouTube only answers this POST with an application/json body, which forces a
// CORS preflight that public proxies don't handle — so it only works through a
// personal server (residential IP, own CORS). Without a server this throws and
// the caller stops paginating cleanly.
async function fetchContinuation(ctx, channelName) {
  const server = getServerUrl();
  let json;
  if (server) {
    const r = await fetch(`${server}/browse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: ctx.apiKey,
        clientVersion: ctx.clientVersion,
        continuation: ctx.token,
      }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      throw new Error(`서버 /browse 응답 ${r.status} ${detail.slice(0, 120)}`);
    }
    json = await r.json();
  } else {
    const url = `https://www.youtube.com/youtubei/v1/browse?key=${ctx.apiKey}`;
    const body = {
      context: { client: { clientName: 'WEB', clientVersion: ctx.clientVersion, hl: 'ko', gl: 'KR' } },
      continuation: ctx.token,
    };
    json = await fetchJsonViaProxyPost(url, body);
  }

  const videos = extractTracksFromResponse(json, channelName);
  const nextToken = findContinuationToken(json);
  const moreCtx = nextToken ? { ...ctx, token: nextToken } : null;
  return { videos, moreCtx };
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

  // 4) Fetch the channel page (if we didn't already) to grab the avatar — RSS
  //    has no avatar. Best-effort: a failure here must NOT fail the add; the UI
  //    falls back to a generated letter avatar.
  if (!html) {
    try {
      html = await fetchViaProxy(`https://www.youtube.com/channel/${authorId}`);
    } catch (e) {
      console.warn('아바타용 채널 페이지 조회 실패 — 아바타 없이 진행', e);
    }
  }
  if (html) {
    // Only override the RSS name if RSS didn't give us one.
    if (author === query) {
      const rawName =
        (html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1] ||
        (html.match(/"title":"([^"]+)","navigationEndpoint"/) || [])[1];
      if (rawName) author = decodeHtmlEntities(rawName);
    }

    // og:image is the channel avatar and is a clean absolute URL; the escaped
    // "avatar" JSON is a fallback for layouts without the meta tag.
    const avatarRaw =
      (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1] ||
      (html.match(/"avatar":\{"thumbnails":\[\{"url":"([^"]+)"/) || [])[1];
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
  // "더 보기" pagination
  moreChannelId: null,    // channel whose list is currently loaded
  moreChannelName: '',    // its display name (used for appended tracks)
  moreCtx: null,          // { channelId, apiKey, clientVersion, token } | null
  canLoadMore: false,     // whether to show the "더 보기" button
  loadingMore: false,     // a "더 보기" fetch is in flight
  resumeOnReturn: false,  // was playing when backgrounded → resume on return
  expectedVideoId: null,  // the videoId we asked the iframe player to play
  lastLoadAt: 0,          // when we last called loadVideoById (drift-guard debounce)
};

// Normalize a pasted server address. A tunnel address is usually copied without
// a scheme ("xxx.trycloudflare.com"); without one every `${server}/audio/...`
// URL resolves *relative to this page*, 404s, and silently falls back to the
// ad-playing YouTube embed — so always force an absolute https:// URL.
function normalizeServerUrl(raw) {
  const url = (raw || '').trim().replace(/\/+$/, '');
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

// Personal background-playback server URL (empty = use YouTube embed fallback).
function getServerUrl() {
  return normalizeServerUrl(localStorage.getItem('mytube_server_url'));
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
          state.lastLoadAt = Date.now();
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
    // Drift guard: if YouTube auto-started a video we never requested — e.g. a
    // "recommended" clip from another channel after ours ended, or an autoplay
    // the ENDED handler missed — snap back to our own queue instead of letting
    // an unrelated channel take over. (Pre-roll ads keep our content's video_id,
    // so this doesn't misfire during ads; the debounce ignores load transitions.)
    const vd = ytPlayer && ytPlayer.getVideoData ? ytPlayer.getVideoData() : null;
    const playingId = vd && vd.video_id;
    if (
      state.engine === 'iframe' &&
      playingId &&
      state.expectedVideoId &&
      playingId !== state.expectedVideoId &&
      Date.now() - state.lastLoadAt > 1500
    ) {
      console.warn('요청하지 않은 영상 자동재생 감지 → 다음 곡으로 교정:', playingId);
      nextTrack();
      return;
    }

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
  // Playback is from a fully-downloaded blob, so 'ended' always means the real
  // end of the track → advance to the next one.
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

// The blob is entirely in memory, so a playback 'error' isn't a network drop
// we can retry — it's a bad/undecodable file. Fall back to the YouTube embed.
audioPlayer.addEventListener('error', () => {
  if (state.engine !== 'server' || !currentAudioBlobUrl) return; // ignore src-clear
  const track = state.currentPlaylist[state.currentTrackIndex];
  if (!track) return;
  console.warn('다운로드한 오디오 재생 오류 — 유튜브 임베드로 폴백');
  trackTitle.textContent = '재생 오류 — 유튜브로 전환 중...';
  playViaIframe(track);
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

// A circular SVG data-URI avatar showing the channel's first letter. Used when
// a channel has no thumbnail or its remote image fails to load.
function letterAvatar(name) {
  const first = ((name || '?').trim().charAt(0) || '?').toUpperCase();
  const ch = first.replace(/[&<>"']/g, '') || '?';
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56">' +
    '<rect width="56" height="56" rx="28" fill="#242739"/>' +
    '<text x="28" y="28" dy="0.35em" text-anchor="middle" ' +
    'font-family="Outfit, sans-serif" font-size="26" font-weight="700" fill="#ff2d73">' +
    ch +
    '</text></svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

// Build a channel avatar <img> that falls back to a letter avatar on load error.
function makeAvatarImg(channel) {
  const img = document.createElement('img');
  img.alt = channel.author || '';
  img.referrerPolicy = 'no-referrer';
  const fallback = letterAvatar(channel.author);
  img.onerror = () => {
    img.onerror = null;
    img.src = fallback;
  };
  const url =
    channel.authorThumbnails && channel.authorThumbnails.length
      ? channel.authorThumbnails[channel.authorThumbnails.length - 1].url
      : null;
  img.src = url || fallback;
  return img;
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
      // Main UI channel card
      const card = document.createElement('div');
      card.className = 'channel-card';
      const cardName = document.createElement('h4');
      cardName.textContent = channel.author;
      card.appendChild(makeAvatarImg(channel));
      card.appendChild(cardName);
      card.addEventListener('click', () => loadChannelVideos(channel.authorId));
      channelsList.appendChild(card);

      // Settings modal list item
      const li = document.createElement('li');
      const info = document.createElement('div');
      info.className = 'settings-ch-info';
      const infoName = document.createElement('span');
      infoName.className = 'settings-ch-name';
      infoName.textContent = channel.author;
      info.appendChild(makeAvatarImg(channel));
      info.appendChild(infoName);

      const delBtn = document.createElement('button');
      delBtn.className = 'delete-btn';
      delBtn.setAttribute('aria-label', '삭제');
      delBtn.innerHTML = '<i data-lucide="trash-2"></i>';
      delBtn.addEventListener('click', () => {
        state.subscribedChannels = state.subscribedChannels.filter(
          (c) => c.authorId !== channel.authorId
        );
        saveSubscribedChannels();
        deleteCachedChannel(channel.authorId);
      });

      li.appendChild(info);
      li.appendChild(delBtn);
      settingsChannelsList.appendChild(li);
    });
  }
  refreshIcons();
}

// ============================================================================
//  Channel video-list cache (LocalStorage)
//  A channel's RSS list rarely changes more than once a day, so re-scraping
//  YouTube through the proxy/server on every single app open is wasted work.
//  Cache each channel's list on the phone and only hit the network again once
//  the cache goes stale — the cached copy still renders instantly either way.
// ============================================================================
const CHANNEL_CACHE_KEY = 'mytube_channel_cache';
const CHANNEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — comfortably under "a day"

function loadChannelCache() {
  try {
    return JSON.parse(localStorage.getItem(CHANNEL_CACHE_KEY) || '{}');
  } catch (e) {
    return {};
  }
}

function getCachedChannel(channelId) {
  return loadChannelCache()[channelId] || null;
}

function setCachedChannel(channelId, videos) {
  const cache = loadChannelCache();
  cache[channelId] = { videos, fetchedAt: Date.now() };
  try {
    localStorage.setItem(CHANNEL_CACHE_KEY, JSON.stringify(cache));
  } catch (e) {
    console.warn('채널 캐시 저장 실패', e);
  }
}

function deleteCachedChannel(channelId) {
  const cache = loadChannelCache();
  if (channelId in cache) {
    delete cache[channelId];
    localStorage.setItem(CHANNEL_CACHE_KEY, JSON.stringify(cache));
  }
}

// ============================================================================
//  Playlist / tracks
// ============================================================================
// Cache-first: a cached list (any age) renders immediately with no network
// wait. A background refresh only actually hits the network when the cache
// is missing or older than CHANNEL_CACHE_TTL_MS, and silently updates the
// list in place if it's still the channel the user is looking at.
async function loadChannelVideos(channelId) {
  switchTab('tracks');

  // Reset pagination for the newly selected channel.
  state.moreChannelId = channelId;
  state.moreCtx = null;
  state.loadingMore = false;
  state.canLoadMore = false;

  const cached = getCachedChannel(channelId);
  if (cached) {
    state.currentPlaylist = cached.videos;
    state.moreChannelName = cached.videos[0]?.author || '';
    state.canLoadMore = true;
    renderTracks();
  } else {
    tracksList.innerHTML = '<div class="empty-msg"><p>영상을 불러오는 중...</p></div>';
    noTracksMsg.style.display = 'none';
  }

  const isFresh = cached && Date.now() - cached.fetchedAt < CHANNEL_CACHE_TTL_MS;
  if (isFresh) return; // cache young enough — skip the network round trip entirely

  try {
    const videos = await fetchChannelVideos(channelId);
    if (videos.length > 0) {
      setCachedChannel(channelId, videos);
      // The user may have switched channels while this was in flight.
      if (state.moreChannelId === channelId) {
        state.currentPlaylist = videos;
        state.moreChannelName = videos[0].author || '';
        state.canLoadMore = true;
        renderTracks();
      }
    } else if (!cached) {
      tracksList.innerHTML = '<div class="empty-msg"><p>동영상이 존재하지 않습니다.</p></div>';
    }
  } catch (e) {
    console.error(e);
    // A cached list is already on screen — a failed background refresh
    // shouldn't rip it away, so only show the error state when there was
    // nothing to fall back on.
    if (!cached) {
      tracksList.innerHTML =
        '<div class="empty-msg"><p>목록을 가져오지 못했습니다. 다시 시도해 주세요.</p></div>';
    }
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

  // "더 보기" — load older videos beyond the RSS window.
  if (state.currentPlaylist.length > 0 && state.canLoadMore) {
    const moreBtn = document.createElement('button');
    moreBtn.className = 'load-more-btn';
    moreBtn.textContent = state.loadingMore ? '불러오는 중...' : '더 보기';
    moreBtn.disabled = state.loadingMore;
    moreBtn.addEventListener('click', loadMoreVideos);
    tracksList.appendChild(moreBtn);
  }
}

// Fetch the next batch of older videos and append them to the current list.
async function loadMoreVideos() {
  if (state.loadingMore || !state.canLoadMore) return;
  state.loadingMore = true;
  renderTracks();

  try {
    const channelName = state.moreChannelName || state.currentPlaylist[0]?.author || '';
    const result = state.moreCtx
      ? await fetchContinuation(state.moreCtx, channelName)
      : await initMorePagination(state.moreChannelId, channelName);

    // Append only videos we don't already have (RSS/earlier pages overlap).
    const existing = new Set(state.currentPlaylist.map((v) => v.videoId));
    const fresh = result.videos.filter((v) => v.videoId && !existing.has(v.videoId));
    state.currentPlaylist.push(...fresh);

    state.moreCtx = result.moreCtx;
    // Stop paginating when: no further token, nothing new arrived, or there is
    // no personal server (further pages need the youtubei POST it proxies).
    if (!result.moreCtx || !result.moreCtx.token || fresh.length === 0 || !getServerUrl()) {
      state.canLoadMore = false;
    }
  } catch (e) {
    console.error('더 보기 실패', e);
    if (getServerUrl()) {
      // With a server this is usually a transient network hiccup — keep the
      // button so the user can just press it again instead of reloading.
      alert('영상을 더 불러오지 못했습니다. 잠시 후 "더 보기"를 다시 눌러 주세요.');
    } else {
      // No server: public proxies can't do the continuation POST — stop quietly
      // (the first batch of ~30 videos is already shown).
      state.canLoadMore = false;
    }
  } finally {
    state.loadingMore = false;
    renderTracks();
  }
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

// Play from the personal server by DOWNLOADING THE WHOLE audio file into memory
// first, then playing it from a Blob URL.
//
// Why fully download instead of streaming? Mobile browsers stop fetching more
// stream data once the screen is off (they suspend background network), so a
// progressively-streamed <audio> plays only as long as its pre-buffered ~2 min
// and then stalls with the screen off. A fully in-memory Blob needs no further
// network at all, so playback survives with the screen off / app backgrounded
// for the whole track — the same reason a downloaded podcast keeps playing.
let currentAudioBlobUrl = null;   // object URL currently loaded (revoke to free)
let audioDownloadAbort = null;    // AbortController for the in-flight download

function revokeCurrentBlob() {
  if (currentAudioBlobUrl) {
    URL.revokeObjectURL(currentAudioBlobUrl);
    currentAudioBlobUrl = null;
  }
}

async function playViaServer(track) {
  state.engine = 'server';
  clearInterval(progressTimer);
  try {
    if (ytPlayer && ytReady) ytPlayer.stopVideo();
  } catch (e) { /* ignore */ }

  // Stop whatever is currently playing right away, so tapping a new track gives
  // immediate feedback ("불러오는 중") instead of the previous track playing on
  // for the length of the new download.
  audioPlayer.pause();
  progressBar.style.width = '0%';
  currentTimeEl.textContent = '0:00';

  // Cancel any download still running for a previously-tapped track.
  if (audioDownloadAbort) audioDownloadAbort.abort();
  audioDownloadAbort = new AbortController();
  const signal = audioDownloadAbort.signal;
  const requestedVideoId = track.videoId;

  // True while THIS track is still the one the user wants (guards against the
  // user tapping another track mid-download).
  const stillCurrent = () =>
    !signal.aborted &&
    state.currentPlaylist[state.currentTrackIndex] &&
    state.currentPlaylist[state.currentTrackIndex].videoId === requestedVideoId;

  trackTitle.textContent = '불러오는 중... ' + track.title;

  try {
    const resp = await fetch(`${getServerUrl()}/audio/${track.videoId}`, { signal });
    if (!resp.ok) throw new Error(`server ${resp.status}`);

    // Read the whole body, updating a % (or MB) indicator as it arrives.
    const total = parseInt(resp.headers.get('Content-Length') || '0', 10);
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!stillCurrent()) { reader.cancel(); return; }
      chunks.push(value);
      received += value.length;
      if (total > 0) {
        trackTitle.textContent = `불러오는 중 ${Math.floor((received / total) * 100)}% — ${track.title}`;
      } else {
        trackTitle.textContent = `불러오는 중 ${(received / 1048576).toFixed(1)}MB — ${track.title}`;
      }
    }

    if (!stillCurrent()) return; // user moved on while downloading — discard

    const blob = new Blob(chunks, { type: resp.headers.get('Content-Type') || 'audio/mp4' });
    revokeCurrentBlob();
    currentAudioBlobUrl = URL.createObjectURL(blob);
    audioPlayer.src = currentAudioBlobUrl;
    audioPlayer.load();
    trackTitle.textContent = track.title;
    audioPlayer.play().catch((err) => console.warn('audio play() rejected:', err));
  } catch (e) {
    if (signal.aborted) return; // superseded by a newer track — not a real error
    console.warn('오디오 다운로드 실패 — 유튜브 임베드로 폴백:', e.message);
    trackTitle.textContent = '서버 다운로드 실패 — 유튜브로 전환 중...';
    playViaIframe(track);
  }
}

// Play through the hidden YouTube IFrame player (no-setup fallback).
function playViaIframe(track) {
  state.engine = 'iframe';
  if (audioDownloadAbort) audioDownloadAbort.abort(); // stop any server download
  try {
    audioPlayer.pause();
    audioPlayer.removeAttribute('src');
    audioPlayer.load();
    revokeCurrentBlob();
  } catch (e) { /* ignore */ }

  state.expectedVideoId = track.videoId;
  if (!ytReady || !ytPlayer) {
    trackTitle.textContent = '플레이어 로딩 중... ' + track.title;
    pendingVideoId = track.videoId;
    return;
  }
  state.lastLoadAt = Date.now();
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

// Auto-resume: the YouTube embed pauses itself when the app is backgrounded
// (e.g. the overview/square button). Remember that we were playing and resume
// when the app returns to the foreground, so it picks up where it left off.
// (visibilitychange → 'hidden' fires before the embed's own pause event, so
//  state.isPlaying still reflects the user's intent at that moment.)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    state.resumeOnReturn = state.isPlaying;
  } else if (document.visibilityState === 'visible') {
    if (state.resumeOnReturn && !state.isPlaying && state.currentTrackIndex >= 0) {
      resumePlayback();
    }
  }
});

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
  const url = normalizeServerUrl(serverUrlInput.value);
  localStorage.setItem('mytube_server_url', url);
  serverUrlInput.value = url; // show the user the address we actually saved

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

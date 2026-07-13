// Invidious instances to fetch data from
const INVIDIOUS_INSTANCES = [
  'https://invidious.projectsegfau.lt',
  'https://invidious.flokinet.to',
  'https://invidious.privacydev.net',
  'https://yewtu.be',
  'https://vid.priv.au'
];

let currentInstanceIndex = 0;

function getBaseUrl() {
  return INVIDIOUS_INSTANCES[currentInstanceIndex];
}

function rotateInstance() {
  currentInstanceIndex = (currentInstanceIndex + 1) % INVIDIOUS_INSTANCES.length;
  console.log(`Switching Invidious instance to: ${getBaseUrl()}`);
}

// Fetch helper with auto-failover
async function fetchFromInvidious(endpoint) {
  let attempts = 0;
  while (attempts < INVIDIOUS_INSTANCES.length) {
    const url = `${getBaseUrl()}${endpoint}`;
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 8000); // 8s timeout

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(id);

      if (response.ok) {
        return await response.json();
      }
    } catch (e) {
      console.warn(`Failed fetching from ${url}:`, e);
    }
    rotateInstance();
    attempts++;
  }
  throw new Error('All Invidious instances failed.');
}

// App State
const state = {
  subscribedChannels: [], // { id, name, authorBanners, authorThumbnails }
  currentPlaylist: [],    // [{ title, videoId, author, publishedText }]
  currentTrackIndex: -1,
  isPlaying: false,
  activeTab: 'channels'   // 'channels' or 'tracks'
};

// DOM Elements
const audioPlayer = document.getElementById('audio-player');
const playBtn = document.getElementById('play-btn');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');
const trackArt = document.getElementById('track-art');
const trackTitle = document.getElementById('track-title');
const trackChannel = document.getElementById('track-channel');
const currentTimeEl = document.getElementById('current-time');
const durationTimeEl = document.getElementById('duration-time');
const progressBar = document.getElementById('progress-bar');
const progressBarContainer = document.getElementById('progress-bar-container');

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

// Initialize Lucide Icons
function refreshIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

// Format Seconds to MM:SS
function formatTime(seconds) {
  if (isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

// Load from LocalStorage
function loadSubscribedChannels() {
  const data = localStorage.getItem('mytube_channels');
  if (data) {
    state.subscribedChannels = JSON.parse(data);
  } else {
    // Default channels for demonstration if empty (하이파이브: LA 최고 예능라디오)
    state.subscribedChannels = [
      {
        author: "하이파이브 : LA 최고 예능라디오",
        authorId: "UCRstLhO5i-Qg5W0VFefuKSw",
        authorThumbnails: [
          { url: "https://yt3.ggpht.com/Iv6GDZpjOzkRddAEn8AzsbsI_iZOUlp08N_7D_BF-p-nou43KVVYV4xpbHPZFUPCKFkiFPBq=s176-c-k-c0x00ffffff-no-rj-mo" }
        ]
      }
    ];
    // 기본값을 로컬스토리지에 저장하여 사용자가 삭제 가능하도록 설정
    localStorage.setItem('mytube_channels', JSON.stringify(state.subscribedChannels));
  }
  updateChannelsUI();
}

// Save to LocalStorage
function saveSubscribedChannels() {
  localStorage.setItem('mytube_channels', JSON.stringify(state.subscribedChannels));
  updateChannelsUI();
}

// Update UI
function updateChannelsUI() {
  channelsList.innerHTML = '';
  settingsChannelsList.innerHTML = '';
  
  const count = state.subscribedChannels.length;
  settingsCount.textContent = count;

  if (count === 0) {
    noChannelsMsg.style.display = 'flex';
  } else {
    noChannelsMsg.style.display = 'none';
    
    state.subscribedChannels.forEach(channel => {
      // Main UI Channel Card
      const card = document.createElement('div');
      card.className = 'channel-card';
      const thumb = channel.authorThumbnails ? channel.authorThumbnails[channel.authorThumbnails.length - 1].url : 'https://images.unsplash.com/photo-1614680376593-902f74fa0d41?w=100';
      
      card.innerHTML = `
        <img src="${thumb}" alt="${channel.author}">
        <h4>${channel.author}</h4>
      `;
      card.addEventListener('click', () => loadChannelVideos(channel.authorId));
      channelsList.appendChild(card);

      // Settings Modal Channel list
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="settings-ch-info">
          <img src="${thumb}" alt="${channel.author}">
          <span class="settings-ch-name">${channel.author}</span>
        </div>
        <button class="delete-btn" aria-label="삭제">
          <i data-lucide="trash-2"></i>
        </button>
      `;
      
      li.querySelector('.delete-btn').addEventListener('click', () => {
        state.subscribedChannels = state.subscribedChannels.filter(c => c.authorId !== channel.authorId);
        saveSubscribedChannels();
      });

      settingsChannelsList.appendChild(li);
    });
  }
  refreshIcons();
}

// Load Videos from Channel
async function loadChannelVideos(channelId) {
  try {
    // Switch to Tracks Tab
    switchTab('tracks');
    tracksList.innerHTML = '<div class="empty-msg"><p>영상을 불러오는 중...</p></div>';
    noTracksMsg.style.display = 'none';

    const data = await fetchFromInvidious(`/api/v1/channels/${channelId}`);
    
    if (data && data.videos && data.videos.length > 0) {
      state.currentPlaylist = data.videos;
      renderTracks();
    } else {
      tracksList.innerHTML = '<div class="empty-msg"><p>동영상이 존재하지 않습니다.</p></div>';
    }
  } catch (e) {
    console.error(e);
    tracksList.innerHTML = '<div class="empty-msg"><p>목록을 가져오지 못했습니다. 다시 시도해 주세요.</p></div>';
  }
}

function renderTracks() {
  tracksList.innerHTML = '';
  state.currentPlaylist.forEach((track, index) => {
    const isCurrent = state.currentTrackIndex === index;
    const item = document.createElement('div');
    item.className = `track-item ${isCurrent ? 'playing' : ''}`;
    
    // Invidious format video thumbnail
    const thumb = track.videoThumbnails ? track.videoThumbnails[0].url : `https://img.youtube.com/vi/${track.videoId}/hqdefault.jpg`;

    item.innerHTML = `
      <img src="${thumb}" alt="${track.title}">
      <div class="track-item-info">
        <div class="track-item-title">${track.title}</div>
        <div class="track-item-date">${track.publishedText || ''}</div>
      </div>
    `;
    item.addEventListener('click', () => playTrack(index));
    tracksList.appendChild(item);
  });
}

// Play Audio
async function playTrack(index) {
  if (index < 0 || index >= state.currentPlaylist.length) return;
  state.currentTrackIndex = index;
  const track = state.currentPlaylist[index];

  // Update Mini Player Info
  trackTitle.textContent = track.title;
  trackChannel.textContent = track.author;
  const thumb = track.videoThumbnails ? track.videoThumbnails[track.videoThumbnails.length - 1].url : `https://img.youtube.com/vi/${track.videoId}/hqdefault.jpg`;
  trackArt.src = thumb;

  // Refresh tracks styling active status
  renderTracks();

  try {
    // Show Loading
    trackTitle.textContent = '불러오는 중... ' + track.title;

    // Fetch video stream info
    const data = await fetchFromInvidious(`/api/v1/videos/${track.videoId}`);
    
    // Filter Audio Streams
    let streamUrl = '';
    if (data.adaptiveFormats && data.adaptiveFormats.length > 0) {
      // Find high quality audio stream
      const audioStreams = data.adaptiveFormats.filter(f => f.type.startsWith('audio/'));
      if (audioStreams.length > 0) {
        // Prefer medium bitrates, fallback to first
        streamUrl = audioStreams[0].url;
      }
    }
    
    // If not found in adaptive, look at formatStreams
    if (!streamUrl && data.formatStreams && data.formatStreams.length > 0) {
      streamUrl = data.formatStreams[0].url;
    }

    if (!streamUrl) {
      throw new Error('No audio stream found.');
    }

    // Load Stream to Audio Element
    audioPlayer.src = streamUrl;
    audioPlayer.load();
    await audioPlayer.play();
    
    state.isPlaying = true;
    updatePlayButton();
    trackTitle.textContent = track.title;
    document.querySelector('.player-panel').classList.add('playing');

    // Update Media Session API for Lockscreen and system notification
    setupMediaSession(track, thumb);

  } catch (err) {
    console.error('Playback Error:', err);
    trackTitle.textContent = '재생 오류: 다음 곡으로 넘어갑니다';
    setTimeout(() => nextTrack(), 2000);
  }
}

// Media Session Setup (Background Notification Control)
function setupMediaSession(track, thumbnail) {
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.author,
      album: 'mytube Radio',
      artwork: [
        { src: thumbnail, sizes: '512x512', type: 'image/jpeg' }
      ]
    });

    navigator.mediaSession.setActionHandler('play', () => {
      audioPlayer.play();
      state.isPlaying = true;
      updatePlayButton();
    });

    navigator.mediaSession.setActionHandler('pause', () => {
      audioPlayer.pause();
      state.isPlaying = false;
      updatePlayButton();
    });

    navigator.mediaSession.setActionHandler('previoustrack', () => {
      prevTrack();
    });

    navigator.mediaSession.setActionHandler('nexttrack', () => {
      nextTrack();
    });
  }
}

// Next / Prev track
function nextTrack() {
  if (state.currentPlaylist.length === 0) return;
  let nextIdx = state.currentTrackIndex + 1;
  if (nextIdx >= state.currentPlaylist.length) nextIdx = 0; // Loop playlist
  playTrack(nextIdx);
}

function prevTrack() {
  if (state.currentPlaylist.length === 0) return;
  let prevIdx = state.currentTrackIndex - 1;
  if (prevIdx < 0) prevIdx = state.currentPlaylist.length - 1; // Loop to end
  playTrack(prevIdx);
}

// Update Play Icon
function updatePlayButton() {
  const icon = playBtn.querySelector('.play-icon');
  if (state.isPlaying) {
    icon.setAttribute('data-lucide', 'pause');
  } else {
    icon.setAttribute('data-lucide', 'play');
  }
  refreshIcons();
}

// Toggle Play/Pause
playBtn.addEventListener('click', async () => {
  if (state.currentTrackIndex === -1) {
    // If playlist is empty, try loading the first subscribed channel's tracks first
    if (state.currentPlaylist.length === 0) {
      if (state.subscribedChannels.length > 0) {
        trackTitle.textContent = '채널 목록 로딩 중...';
        await loadChannelVideos(state.subscribedChannels[0].authorId);
      } else {
        alert('구독 중인 채널이 없습니다. 설정에서 채널을 추가해 주세요.');
        return;
      }
    }
    
    // Play first track of playlist
    if (state.currentPlaylist.length > 0) {
      playTrack(0);
    }
    return;
  }

  if (state.isPlaying) {
    audioPlayer.pause();
    state.isPlaying = false;
    document.querySelector('.player-panel').classList.remove('playing');
  } else {
    try {
      await audioPlayer.play();
      state.isPlaying = true;
      document.querySelector('.player-panel').classList.add('playing');
    } catch (e) {
      console.error("Playback failed", e);
    }
  }
  updatePlayButton();
});

// Event Listeners for Audio element
audioPlayer.addEventListener('timeupdate', () => {
  const current = audioPlayer.currentTime;
  const duration = audioPlayer.duration;
  currentTimeEl.textContent = formatTime(current);
  
  if (!isNaN(duration)) {
    durationTimeEl.textContent = formatTime(duration);
    const progressPercent = (current / duration) * 100;
    progressBar.style.width = `${progressPercent}%`;
  }
});

audioPlayer.addEventListener('ended', () => {
  nextTrack();
});

// Click on Progress Bar to Seek
progressBarContainer.addEventListener('click', (e) => {
  const width = progressBarContainer.clientWidth;
  const clickX = e.offsetX;
  const duration = audioPlayer.duration;
  if (!isNaN(duration)) {
    audioPlayer.currentTime = (clickX / width) * duration;
  }
});

// Previous and Next Buttons
prevBtn.addEventListener('click', prevTrack);
nextBtn.addEventListener('click', nextTrack);

// Tabs Navigation
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

// Settings Modal
settingsBtn.addEventListener('click', () => {
  settingsModal.classList.add('active');
});

closeSettingsBtn.addEventListener('click', () => {
  settingsModal.classList.remove('active');
});

// Close modal when click outside of card
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) {
    settingsModal.classList.remove('active');
  }
});

// Search & Add Channel
addChannelBtn.addEventListener('click', async () => {
  let query = channelSearchInput.value.trim();
  if (!query) return;

  addChannelBtn.disabled = true;
  addChannelBtn.textContent = '검색중';

  try {
    let channelData = null;
    
    // Case 1: UC... ID format
    if (query.startsWith('UC') && query.length === 24) {
      channelData = await fetchFromInvidious(`/api/v1/channels/${query}`);
    } else {
      // Case 2: search by query/handle
      // Handle cleanup if user input with @
      const cleanQuery = query.startsWith('@') ? query : query;
      const searchResults = await fetchFromInvidious(`/api/v1/search?q=${encodeURIComponent(cleanQuery)}&type=channel`);
      
      if (searchResults && searchResults.length > 0) {
        const bestMatch = searchResults[0];
        channelData = await fetchFromInvidious(`/api/v1/channels/${bestMatch.authorId}`);
      }
    }

    if (channelData && channelData.authorId) {
      // Check duplicate
      const exists = state.subscribedChannels.some(c => c.authorId === channelData.authorId);
      if (!exists) {
        state.subscribedChannels.push({
          author: channelData.author,
          authorId: channelData.authorId,
          authorThumbnails: channelData.authorThumbnails
        });
        saveSubscribedChannels();
        channelSearchInput.value = '';
        alert(`${channelData.author} 채널이 구독 목록에 추가되었습니다.`);
      } else {
        alert('이미 추가된 채널입니다.');
      }
    } else {
      alert('채널을 찾을 수 없습니다. 정확한 ID나 채널명을 입력해주세요.');
    }
  } catch (err) {
    console.error(err);
    alert('채널 정보 탐색 실패. 네트워크 상태나 인스턴스를 확인해 주세요.');
  } finally {
    addChannelBtn.disabled = false;
    addChannelBtn.textContent = '추가';
  }
});

// Service Worker Registration
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('ServiceWorker registered with scope: ', reg.scope))
      .catch(err => console.error('ServiceWorker registration failed: ', err));
  });
}

// Initial Load
loadSubscribedChannels();
refreshIcons();

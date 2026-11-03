/**
 * pdfun - Client-Side Controller (Vanilla HTML/CSS/JS)
 * Features:
 * - Chunk-streamed upload with real progress tracking (No size limit)
 * - PDF.js client-side thumbnail rendering & page preview modal
 * - Interactive cut-point scissor dividers & page selection
 * - Multiple split modes: Visual Cut, Ranges, Interval, All Pages, Even/Odd, Bookmarks
 * - Merge & Rotate PDF tools
 * - Live storage statistics & session cleanup
 * - Dark / Light theme persistence
 */

// Initialize PDF.js worker
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/js/vendor/pdf.worker.min.js';
}

// Global Application State
const AppState = {
  theme: localStorage.getItem('pdfun_theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
  
  // Split State
  split: {
    sessionId: null,
    filename: null,
    fileSizeDisplay: '',
    totalPages: 0,
    bookmarks: [],
    pdfDoc: null,
    activeMode: 'cut_points', // 'cut_points' | 'ranges' | 'selected' | 'interval' | 'all' | 'even_odd' | 'bookmarks'
    selectedPages: new Set(), // 1-based page numbers
    cutPoints: new Set(),     // 1-based page numbers after which to cut
    renderedThumbs: new Set(),
  },

  // Modal Preview State
  preview: {
    currentPage: 1,
    totalPages: 1,
  },

  // Merge State
  merge: {
    files: [], // Array of File objects
  },

  // Rotate State
  rotate: {
    sessionId: null,
    filename: null,
    totalPages: 0,
    angle: 90,
  }
};

// ==========================================================
// Initialization & Theme Handling
// ==========================================================
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initTabs();
  initStorageStats();
  initSplitDropzone();
  initSplitModeSelector();
  initSplitPresets();
  initSplitGridActions();
  initSplitExecution();
  initMergeTool();
  initRotateTool();
  initPreviewModal();
});

function initTheme() {
  document.documentElement.setAttribute('data-theme', AppState.theme);
  const toggleBtn = document.getElementById('themeToggle');
  toggleBtn.textContent = AppState.theme === 'dark' ? '☀️' : '🌙';

  toggleBtn.addEventListener('click', () => {
    AppState.theme = AppState.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', AppState.theme);
    localStorage.setItem('pdfun_theme', AppState.theme);
    toggleBtn.textContent = AppState.theme === 'dark' ? '☀️' : '🌙';
  });
}

function initTabs() {
  const tabButtons = document.querySelectorAll('.nav-tabs .tab-btn');
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-tab');
      tabButtons.forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      const targetContent = document.getElementById(targetId);
      if (targetContent) {
        targetContent.classList.add('active');
      }

      if (targetId === 'tab-system') {
        fetchStorageStats();
      }
    });
  });

  const storageBadge = document.getElementById('storageBadge');
  if (storageBadge) {
    storageBadge.addEventListener('click', () => {
      document.querySelector('[data-tab="tab-system"]').click();
    });
  }
}

// Toast Notifications
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
  toast.innerHTML = `<span>${icon}</span><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function escapeHtml(str) {
  if (!str) return '';
  return str.toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ==========================================================
// Storage Stats & System Info
// ==========================================================
function initStorageStats() {
  fetchStorageStats();
  const refreshBtn = document.getElementById('btnRefreshStats');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      fetchStorageStats();
      showToast('Storage statistics refreshed.', 'info');
    });
  }
}

async function fetchStorageStats() {
  try {
    const res = await fetch('/api/system-info');
    if (!res.ok) return;
    const data = await res.json();
    const storage = data.storage || {};

    const badgeText = document.getElementById('storageBadgeText');
    if (badgeText && storage.free_gb !== undefined) {
      badgeText.textContent = `Storage: ${storage.free_gb} GB Free (No Size Limit)`;
    }

    const statFreeGb = document.getElementById('statFreeGb');
    if (statFreeGb) statFreeGb.textContent = `${storage.free_gb || 0} GB`;

    const statFreePercent = document.getElementById('statFreePercent');
    if (statFreePercent) statFreePercent.textContent = `${storage.free_percent || 0}% disk free`;

    const statActiveSessions = document.getElementById('statActiveSessions');
    if (statActiveSessions) statActiveSessions.textContent = storage.active_sessions || 0;
  } catch (err) {
    console.warn('Failed to fetch storage stats:', err);
  }
}

// ==========================================================
// TAB 1: SPLIT PDF LOGIC
// ==========================================================
function initSplitDropzone() {
  const dropzone = document.getElementById('splitDropzone');
  const fileInput = document.getElementById('splitFileInput');
  const progressContainer = document.getElementById('splitUploadProgress');
  const progressBar = document.getElementById('uploadProgressBar');
  const progressPercent = document.getElementById('uploadProgressPercent');
  const progressLabel = document.getElementById('uploadProgressLabel');

  dropzone.addEventListener('click', () => fileInput.click());

  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, e => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, e => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dragover');
    });
  });

  dropzone.addEventListener('drop', e => {
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleSplitUpload(files[0]);
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      handleSplitUpload(fileInput.files[0]);
    }
  });

  document.getElementById('btnChangePdf').addEventListener('click', () => {
    resetSplitUI();
  });

  document.getElementById('btnDeleteSession').addEventListener('click', async () => {
    if (!AppState.split.sessionId) return;
    if (confirm('Are you sure you want to delete this session and wipe files from server storage?')) {
      await fetch(`/api/session/${AppState.split.sessionId}`, { method: 'DELETE' });
      showToast('Session and temporary files deleted from disk.', 'info');
      resetSplitUI();
      fetchStorageStats();
    }
  });

  document.getElementById('btnDeleteFinishedSession').addEventListener('click', async () => {
    if (!AppState.split.sessionId) return;
    await fetch(`/api/session/${AppState.split.sessionId}`, { method: 'DELETE' });
    showToast('Session cleaned up.', 'info');
    resetSplitUI();
    fetchStorageStats();
  });

  document.getElementById('btnSplitAgain').addEventListener('click', () => {
    document.getElementById('splitResultsCard').style.display = 'none';
    document.getElementById('splitWorkspace').style.display = 'block';
  });
}

function resetSplitUI() {
  AppState.split.sessionId = null;
  AppState.split.filename = null;
  AppState.split.totalPages = 0;
  AppState.split.bookmarks = [];
  AppState.split.pdfDoc = null;
  AppState.split.selectedPages.clear();
  AppState.split.cutPoints.clear();
  AppState.split.renderedThumbs.clear();

  document.getElementById('splitFileInput').value = '';
  document.getElementById('splitUploadProgress').style.display = 'none';
  document.getElementById('uploadProgressBar').style.width = '0%';
  document.getElementById('splitUploadCard').style.display = 'block';
  document.getElementById('splitWorkspace').style.display = 'none';
  document.getElementById('splitResultsCard').style.display = 'none';
  document.getElementById('pageGridContainer').innerHTML = '';
}

function handleSplitUpload(file) {
  if (!file.name.toLowerCase().endsWith('.pdf')) {
    showToast('Please select a valid PDF file.', 'error');
    return;
  }

  const progressContainer = document.getElementById('splitUploadProgress');
  const progressBar = document.getElementById('uploadProgressBar');
  const progressPercent = document.getElementById('uploadProgressPercent');
  const progressLabel = document.getElementById('uploadProgressLabel');

  progressContainer.style.display = 'block';
  progressBar.style.width = '0%';
  progressPercent.textContent = '0%';
  progressLabel.textContent = `Streaming "${file.name}" to backend (No size limit)...`;

  const formData = new FormData();
  formData.append('file', file);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload', true);

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      progressBar.style.width = `${pct}%`;
      progressPercent.textContent = `${pct}%`;
      if (pct === 100) {
        progressLabel.textContent = 'Analyzing PDF structure and chapters...';
      }
    }
  };

  xhr.onload = async () => {
    if (xhr.status === 200) {
      try {
        const data = JSON.parse(xhr.responseText);
        onSplitUploadSuccess(data);
      } catch (err) {
        showToast('Failed to parse server response.', 'error');
        progressContainer.style.display = 'none';
      }
    } else {
      let errMsg = 'Upload failed.';
      try {
        const errJson = JSON.parse(xhr.responseText);
        errMsg = errJson.detail || errMsg;
      } catch (e) {}
      showToast(errMsg, 'error');
      progressContainer.style.display = 'none';
    }
  };

  xhr.onerror = () => {
    showToast('Network error during upload.', 'error');
    progressContainer.style.display = 'none';
  };

  xhr.send(formData);
}

async function onSplitUploadSuccess(res) {
  const info = res.info;
  AppState.split.sessionId = res.session_id;
  AppState.split.filename = res.filename;
  AppState.split.fileSizeDisplay = info.filesize_display;
  AppState.split.totalPages = info.total_pages;
  AppState.split.bookmarks = info.bookmarks || [];

  // Default: select all pages
  AppState.split.selectedPages.clear();
  AppState.split.cutPoints.clear();
  for (let i = 1; i <= info.total_pages; i++) {
    AppState.split.selectedPages.add(i);
  }

  // Update UI Meta Bar
  document.getElementById('docFileName').textContent = res.filename;
  document.getElementById('docFileSizeBadge').textContent = info.filesize_display;
  document.getElementById('docTotalPagesBadge').textContent = `${info.total_pages} Pages`;

  const bmBadge = document.getElementById('docBookmarksBadge');
  const bmCard = document.getElementById('bookmarkModeCard');
  if (info.bookmarks && info.bookmarks.length > 0) {
    bmBadge.style.display = 'inline-block';
    bmCard.style.display = 'block';
    renderBookmarksList(info.bookmarks);
  } else {
    bmBadge.style.display = 'none';
    bmCard.style.display = 'none';
  }

  // Switch views
  document.getElementById('splitUploadCard').style.display = 'none';
  document.getElementById('splitWorkspace').style.display = 'block';
  showToast(`Loaded ${info.filename} (${info.total_pages} pages).`, 'success');

  // Load PDF for visual thumbnails
  loadPdfForThumbnails(`/api/session/${res.session_id}/source/${encodeURIComponent(res.filename)}`);
  updateSplitSummary();
  fetchStorageStats();
}

function renderBookmarksList(bookmarks) {
  const list = document.getElementById('bookmarksPreviewList');
  list.innerHTML = '';
  bookmarks.forEach((bm, idx) => {
    const li = document.createElement('li');
    li.style.marginBottom = '4px';
    li.innerHTML = `<strong>Part ${idx + 1}:</strong> "${escapeHtml(bm.title)}" (Starts on Page ${bm.page})`;
    list.appendChild(li);
  });
}

// PDF.js Thumbnail Loader
async function loadPdfForThumbnails(pdfUrl) {
  const container = document.getElementById('pageGridContainer');
  container.innerHTML = '<div style="padding: 30px; text-align: center; width: 100%; color: var(--text-muted);">Rendering page thumbnails...</div>';

  try {
    const loadingTask = pdfjsLib.getDocument(pdfUrl);
    const pdf = await loadingTask.promise;
    AppState.split.pdfDoc = pdf;

    container.innerHTML = '';
    const total = pdf.numPages;

    for (let pageNum = 1; pageNum <= total; pageNum++) {
      // Create thumbnail card
      const wrapper = document.createElement('div');
      wrapper.className = 'page-item-wrapper';

      const card = createPageCard(pageNum);
      wrapper.appendChild(card);

      // Add cut divider between pages (not after the last page)
      if (pageNum < total) {
        const divider = createCutDivider(pageNum);
        wrapper.appendChild(divider);
      }

      container.appendChild(wrapper);

      // Render thumbnail asynchronously
      renderThumbnail(pdf, pageNum, card.querySelector('canvas'));
    }

    updateGridStats();
  } catch (err) {
    console.error('PDF.js rendering error:', err);
    container.innerHTML = `<div style="padding: 20px; color: var(--danger); text-align: center;">Failed to render thumbnails: ${escapeHtml(err.message)}</div>`;
  }
}

function createPageCard(pageNum) {
  const card = document.createElement('div');
  card.className = 'page-thumbnail-card selected';
  card.setAttribute('data-page', pageNum);

  card.innerHTML = `
    <div class="thumbnail-canvas-wrap">
      <canvas id="thumb-canvas-${pageNum}"></canvas>
    </div>
    <div class="page-card-footer">
      <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
        <input type="checkbox" class="page-card-checkbox" checked data-page="${pageNum}" />
        <span>Page ${pageNum}</span>
      </label>
      <button type="button" class="page-zoom-btn" title="View Full Page" data-zoom="${pageNum}">🔍</button>
    </div>
  `;

  // Toggle selection on card click
  card.addEventListener('click', (e) => {
    if (e.target.closest('.page-zoom-btn')) {
      e.stopPropagation();
      openPreviewModal(pageNum);
      return;
    }
    const chk = card.querySelector('.page-card-checkbox');
    if (e.target !== chk) {
      chk.checked = !chk.checked;
    }
    togglePageSelection(pageNum, chk.checked);
  });

  return card;
}

function createCutDivider(pageNum) {
  const divider = document.createElement('div');
  divider.className = 'cut-divider';
  divider.setAttribute('data-cut-after', pageNum);
  divider.title = `Click to cut document after Page ${pageNum}`;

  divider.innerHTML = `
    <div class="cut-divider-line"></div>
    <button type="button" class="cut-divider-btn">✂️</button>
  `;

  divider.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleCutPoint(pageNum, divider);
  });

  return divider;
}

function toggleCutPoint(pageNum, dividerEl) {
  if (AppState.split.cutPoints.has(pageNum)) {
    AppState.split.cutPoints.delete(pageNum);
    dividerEl.classList.remove('active');
  } else {
    AppState.split.cutPoints.add(pageNum);
    dividerEl.classList.add('active');
  }
  updateCutPointsSummary();
  updateSplitSummary();
}

function togglePageSelection(pageNum, isSelected) {
  const card = document.querySelector(`.page-thumbnail-card[data-page="${pageNum}"]`);
  if (isSelected) {
    AppState.split.selectedPages.add(pageNum);
    if (card) {
      card.classList.add('selected');
      card.classList.remove('deselected');
    }
  } else {
    AppState.split.selectedPages.delete(pageNum);
    if (card) {
      card.classList.remove('selected');
      card.classList.add('deselected');
    }
  }
  updateGridStats();
  updateSplitSummary();
}

async function renderThumbnail(pdf, pageNum, canvas) {
  try {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 0.28 });
    const context = canvas.getContext('2d');
    canvas.height = viewport.height;
    canvas.width = viewport.width;

    await page.render({
      canvasContext: context,
      viewport: viewport,
    }).promise;
  } catch (err) {
    console.warn(`Error rendering thumbnail page ${pageNum}:`, err);
  }
}

function updateGridStats() {
  const total = AppState.split.totalPages;
  const selectedCount = AppState.split.selectedPages.size;
  document.getElementById('gridSelectionStats').textContent = `Selected: ${selectedCount} of ${total} pages`;
}

function updateCutPointsSummary() {
  const summaryEl = document.getElementById('cutPointsSummary');
  const cuts = Array.from(AppState.split.cutPoints).sort((a, b) => a - b);
  if (cuts.length === 0) {
    summaryEl.textContent = 'No cut points set yet. (Click scissor dividers between pages to add cuts)';
    summaryEl.style.color = 'var(--text-muted)';
  } else {
    const totalParts = cuts.length + 1;
    summaryEl.textContent = `✂️ ${cuts.length} cut(s) set after pages: [${cuts.join(', ')}] → splits into ${totalParts} documents.`;
    summaryEl.style.color = 'var(--accent-rose)';
  }
}

// Mode Selector Handling
function initSplitModeSelector() {
  const modeCards = document.querySelectorAll('.split-mode-selector .mode-card');
  modeCards.forEach(card => {
    card.addEventListener('click', () => {
      const mode = card.getAttribute('data-mode');
      setSplitMode(mode);
    });
  });

  // Range and interval listeners
  document.getElementById('rangeInput').addEventListener('input', updateSplitSummary);
  document.getElementById('rangeMergeCheckbox').addEventListener('change', updateSplitSummary);
  document.getElementById('selectedMergeCheckbox').addEventListener('change', updateSplitSummary);
  
  const intervalInput = document.getElementById('intervalInput');
  intervalInput.addEventListener('input', () => {
    const val = parseInt(intervalInput.value, 10) || 1;
    const total = AppState.split.totalPages || 0;
    const parts = Math.ceil(total / val);
    document.getElementById('intervalHelper').textContent = `Splits ${total} pages into ${parts} parts of up to ${val} pages each.`;
    updateSplitSummary();
  });
}

function setSplitMode(mode) {
  AppState.split.activeMode = mode;
  document.querySelectorAll('.split-mode-selector .mode-card').forEach(c => c.classList.remove('active'));
  const activeCard = document.querySelector(`.split-mode-selector .mode-card[data-mode="${mode}"]`);
  if (activeCard) activeCard.classList.add('active');

  // Hide all panels, show target panel
  document.querySelectorAll('.split-options-panel .mode-panel').forEach(p => p.style.display = 'none');
  const targetPanel = document.getElementById(`panel-${mode}`);
  if (targetPanel) targetPanel.style.display = 'block';

  updateSplitSummary();
}

function initSplitPresets() {
  document.getElementById('presetFirstHalf').addEventListener('click', () => {
    const half = Math.ceil(AppState.split.totalPages / 2);
    document.getElementById('rangeInput').value = `1-${half}`;
    updateSplitSummary();
  });

  document.getElementById('presetSecondHalf').addEventListener('click', () => {
    const start = Math.ceil(AppState.split.totalPages / 2) + 1;
    document.getElementById('rangeInput').value = `${start}-${AppState.split.totalPages}`;
    updateSplitSummary();
  });

  document.getElementById('presetAllOdd').addEventListener('click', () => {
    const odds = [];
    for (let i = 1; i <= AppState.split.totalPages; i += 2) odds.push(i);
    document.getElementById('rangeInput').value = odds.join(', ');
    updateSplitSummary();
  });

  document.getElementById('presetAllEven').addEventListener('click', () => {
    const evens = [];
    for (let i = 2; i <= AppState.split.totalPages; i += 2) evens.push(i);
    document.getElementById('rangeInput').value = evens.join(', ');
    updateSplitSummary();
  });
}

function initSplitGridActions() {
  document.getElementById('btnSelectAll').addEventListener('click', () => {
    for (let i = 1; i <= AppState.split.totalPages; i++) {
      AppState.split.selectedPages.add(i);
    }
    syncGridCheckboxes();
  });

  document.getElementById('btnDeselectAll').addEventListener('click', () => {
    AppState.split.selectedPages.clear();
    syncGridCheckboxes();
  });

  document.getElementById('btnInvertSelection').addEventListener('click', () => {
    for (let i = 1; i <= AppState.split.totalPages; i++) {
      if (AppState.split.selectedPages.has(i)) {
        AppState.split.selectedPages.delete(i);
      } else {
        AppState.split.selectedPages.add(i);
      }
    }
    syncGridCheckboxes();
  });

  document.getElementById('btnSelectOdd').addEventListener('click', () => {
    AppState.split.selectedPages.clear();
    for (let i = 1; i <= AppState.split.totalPages; i += 2) {
      AppState.split.selectedPages.add(i);
    }
    syncGridCheckboxes();
  });

  document.getElementById('btnSelectEven').addEventListener('click', () => {
    AppState.split.selectedPages.clear();
    for (let i = 2; i <= AppState.split.totalPages; i += 2) {
      AppState.split.selectedPages.add(i);
    }
    syncGridCheckboxes();
  });

  document.getElementById('btnClearCuts').addEventListener('click', () => {
    AppState.split.cutPoints.clear();
    document.querySelectorAll('.cut-divider').forEach(d => d.classList.remove('active'));
    updateCutPointsSummary();
    updateSplitSummary();
  });
}

function syncGridCheckboxes() {
  document.querySelectorAll('.page-thumbnail-card').forEach(card => {
    const pageNum = parseInt(card.getAttribute('data-page'), 10);
    const isSelected = AppState.split.selectedPages.has(pageNum);
    const chk = card.querySelector('.page-card-checkbox');
    if (chk) chk.checked = isSelected;
    if (isSelected) {
      card.classList.add('selected');
      card.classList.remove('deselected');
    } else {
      card.classList.remove('selected');
      card.classList.add('deselected');
    }
  });
  updateGridStats();
  updateSplitSummary();
}

function updateSplitSummary() {
  const summaryEl = document.getElementById('splitSummaryText');
  const mode = AppState.split.activeMode;
  const total = AppState.split.totalPages;

  if (mode === 'cut_points') {
    const cuts = AppState.split.cutPoints.size;
    summaryEl.textContent = `Visual Split: ${cuts} cut(s) selected → will create ${cuts + 1} PDF file(s).`;
  } else if (mode === 'ranges') {
    const val = document.getElementById('rangeInput').value.trim();
    const merge = document.getElementById('rangeMergeCheckbox').checked;
    summaryEl.textContent = val ? `Ranges [${val}]: Output as ${merge ? '1 combined PDF' : 'separate PDFs in a ZIP archive'}.` : 'Please enter page ranges.';
  } else if (mode === 'selected') {
    const count = AppState.split.selectedPages.size;
    const merge = document.getElementById('selectedMergeCheckbox').checked;
    summaryEl.textContent = `Extracting ${count} selected page(s) → ${merge ? '1 single combined PDF' : `${count} individual PDFs in ZIP`}.`;
  } else if (mode === 'interval') {
    const interval = parseInt(document.getElementById('intervalInput').value, 10) || 1;
    const parts = Math.ceil(total / interval);
    summaryEl.textContent = `Every ${interval} pages → ${parts} separate PDF file(s).`;
  } else if (mode === 'all') {
    summaryEl.textContent = `Extract all ${total} pages as individual single-page PDFs packaged in a ZIP.`;
  } else if (mode === 'even_odd') {
    summaryEl.textContent = `Split into 2 files: odd pages PDF and even pages PDF.`;
  } else if (mode === 'bookmarks') {
    const bmCount = AppState.split.bookmarks.length;
    summaryEl.textContent = `Split by ${bmCount} detected bookmark chapters into separate PDFs.`;
  }
}

// Split Execution
function initSplitExecution() {
  const executeBtn = document.getElementById('btnExecuteSplit');
  executeBtn.addEventListener('click', async () => {
    if (!AppState.split.sessionId || !AppState.split.filename) {
      showToast('No PDF loaded.', 'error');
      return;
    }

    const mode = AppState.split.activeMode;
    const payload = {
      session_id: AppState.split.sessionId,
      filename: AppState.split.filename,
      mode: mode,
    };

    if (mode === 'cut_points') {
      if (AppState.split.cutPoints.size === 0) {
        showToast('Please set at least one cut point by clicking the scissor divider between pages.', 'warning');
        return;
      }
      payload.cut_points = Array.from(AppState.split.cutPoints).sort((a, b) => a - b);
    } else if (mode === 'ranges') {
      const rangeStr = document.getElementById('rangeInput').value.trim();
      if (!rangeStr) {
        showToast('Please specify page ranges (e.g. 1-3, 5-7).', 'warning');
        return;
      }
      payload.ranges_str = rangeStr;
      payload.merge_ranges = document.getElementById('rangeMergeCheckbox').checked;
    } else if (mode === 'selected') {
      if (AppState.split.selectedPages.size === 0) {
        showToast('Please select at least one page to extract.', 'warning');
        return;
      }
      payload.selected_pages = Array.from(AppState.split.selectedPages).sort((a, b) => a - b);
      payload.merge_ranges = document.getElementById('selectedMergeCheckbox').checked;
    } else if (mode === 'interval') {
      const interval = parseInt(document.getElementById('intervalInput').value, 10);
      if (!interval || interval < 1) {
        showToast('Please specify a valid interval (1 or more).', 'warning');
        return;
      }
      payload.interval = interval;
    }

    // Set loading state
    executeBtn.disabled = true;
    executeBtn.innerHTML = '<span>⏳</span> Splitting PDF...';

    try {
      const res = await fetch('/api/split', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const resData = await res.json();
      if (!res.ok) {
        throw new Error(resData.detail || 'Failed to split PDF');
      }

      onSplitComplete(resData.data);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      executeBtn.disabled = false;
      executeBtn.innerHTML = '<span>✂️</span> Split PDF with pdfun';
    }
  });
}

function onSplitComplete(data) {
  document.getElementById('splitWorkspace').style.display = 'none';
  const resultsCard = document.getElementById('splitResultsCard');
  resultsCard.style.display = 'block';

  document.getElementById('resultsSubtitle').textContent = 
    `Generated ${data.total_files} PDF file(s) from "${escapeHtml(data.original_filename)}" (Total: ${data.total_bytes_display})`;

  // ZIP Banner
  const zipBanner = document.getElementById('zipDownloadBanner');
  const btnZip = document.getElementById('btnDownloadZip');
  if (data.zip_package && data.total_files > 1) {
    zipBanner.style.display = 'flex';
    document.getElementById('zipDownloadTitle').textContent = `Download All ${data.total_files} Parts as ZIP`;
    document.getElementById('zipDownloadDesc').textContent = `${data.zip_package.filename} (${data.zip_package.filesize_display})`;
    btnZip.href = data.zip_package.download_url;
  } else {
    zipBanner.style.display = 'none';
  }

  // Populate Table
  const tbody = document.getElementById('resultsTableBody');
  tbody.innerHTML = '';
  data.files.forEach(file => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${escapeHtml(file.filename)}</strong></td>
      <td>${file.pages} page${file.pages === 1 ? '' : 's'}</td>
      <td>${file.filesize_display}</td>
      <td style="text-align: right;">
        <div class="file-row-actions" style="justify-content: flex-end;">
          <a href="${file.preview_url}" target="_blank" class="btn btn-secondary btn-sm" title="Preview PDF inline">👁️ Preview</a>
          <a href="${file.download_url}" download class="btn btn-primary btn-sm" title="Download PDF">⬇️ Download</a>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  showToast(`Success! Generated ${data.total_files} file(s).`, 'success');
  window.scrollTo({ top: resultsCard.offsetTop - 80, behavior: 'smooth' });
}

// ==========================================================
// TAB 2: MERGE PDF TOOL
// ==========================================================
function initMergeTool() {
  const dropzone = document.getElementById('mergeDropzone');
  const fileInput = document.getElementById('mergeFileInput');
  const listContainer = document.getElementById('mergeListContainer');
  const addMoreBtn = document.getElementById('btnAddMoreMergeFiles');
  const executeBtn = document.getElementById('btnExecuteMerge');
  const resultCard = document.getElementById('mergeResultCard');
  const downloadBtn = document.getElementById('btnDownloadMerged');

  dropzone.addEventListener('click', () => fileInput.click());
  addMoreBtn.addEventListener('click', () => fileInput.click());

  ['dragenter', 'dragover'].forEach(name => {
    dropzone.addEventListener(name, e => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(name => {
    dropzone.addEventListener(name, e => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    });
  });

  dropzone.addEventListener('drop', e => {
    const files = Array.from(e.dataTransfer.files).filter(f => f.name.toLowerCase().endsWith('.pdf'));
    if (files.length > 0) {
      addMergeFiles(files);
    }
  });

  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files).filter(f => f.name.toLowerCase().endsWith('.pdf'));
    if (files.length > 0) {
      addMergeFiles(files);
    }
  });

  executeBtn.addEventListener('click', async () => {
    if (AppState.merge.files.length < 2) {
      showToast('Please add at least 2 PDF files to merge.', 'warning');
      return;
    }

    executeBtn.disabled = true;
    executeBtn.innerHTML = '<span>⏳</span> Merging PDFs...';

    const formData = new FormData();
    AppState.merge.files.forEach(f => formData.append('files', f));

    try {
      const res = await fetch('/api/merge', {
        method: 'POST',
        body: formData,
      });

      const resData = await res.json();
      if (!res.ok) throw new Error(resData.detail || 'Failed to merge');

      resultCard.style.display = 'block';
      const output = resData.data.files[0];
      downloadBtn.href = output.download_url;
      document.getElementById('mergeResultSubtitle').textContent = 
        `Combined ${AppState.merge.files.length} documents into "${output.filename}" (${output.filesize_display}, ${output.pages} pages).`;
      showToast('Merged successfully!', 'success');
      resultCard.scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      executeBtn.disabled = false;
      executeBtn.innerHTML = '<span>📑</span> Merge PDFs Now';
    }
  });
}

function addMergeFiles(newFiles) {
  AppState.merge.files = AppState.merge.files.concat(newFiles);
  renderMergeList();
}

function renderMergeList() {
  const container = document.getElementById('mergeListContainer');
  const list = document.getElementById('mergeFilesList');
  const files = AppState.merge.files;

  if (files.length === 0) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  list.innerHTML = '';

  files.forEach((file, idx) => {
    const item = document.createElement('div');
    item.className = 'merge-item';
    item.innerHTML = `
      <div class="merge-item-info">
        <span style="font-weight: 700; color: var(--text-muted);">${idx + 1}.</span>
        <div>
          <div style="font-weight: 600;">${escapeHtml(file.name)}</div>
          <div style="font-size: 0.78rem; color: var(--text-muted);">${formatBytes(file.size)}</div>
        </div>
      </div>
      <div class="merge-item-actions">
        <button type="button" class="btn btn-secondary btn-sm btn-move-up" ${idx === 0 ? 'disabled' : ''} title="Move Up">↑</button>
        <button type="button" class="btn btn-secondary btn-sm btn-move-down" ${idx === files.length - 1 ? 'disabled' : ''} title="Move Down">↓</button>
        <button type="button" class="btn btn-danger-outline btn-sm btn-remove-merge" title="Remove">✕</button>
      </div>
    `;

    item.querySelector('.btn-move-up').addEventListener('click', () => {
      if (idx > 0) {
        const tmp = files[idx - 1];
        files[idx - 1] = files[idx];
        files[idx] = tmp;
        renderMergeList();
      }
    });

    item.querySelector('.btn-move-down').addEventListener('click', () => {
      if (idx < files.length - 1) {
        const tmp = files[idx + 1];
        files[idx + 1] = files[idx];
        files[idx] = tmp;
        renderMergeList();
      }
    });

    item.querySelector('.btn-remove-merge').addEventListener('click', () => {
      AppState.merge.files.splice(idx, 1);
      renderMergeList();
    });

    list.appendChild(item);
  });
}

// ==========================================================
// TAB 3: ROTATE PDF TOOL
// ==========================================================
function initRotateTool() {
  const dropzone = document.getElementById('rotateDropzone');
  const fileInput = document.getElementById('rotateFileInput');
  const workspace = document.getElementById('rotateWorkspace');
  const changeBtn = document.getElementById('btnChangeRotateDoc');
  const executeBtn = document.getElementById('btnExecuteRotate');

  dropzone.addEventListener('click', () => fileInput.click());

  ['dragenter', 'dragover'].forEach(name => {
    dropzone.addEventListener(name, e => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(name => {
    dropzone.addEventListener(name, e => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    });
  });

  dropzone.addEventListener('drop', e => {
    const files = e.dataTransfer.files;
    if (files.length > 0) handleRotateUpload(files[0]);
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) handleRotateUpload(fileInput.files[0]);
  });

  changeBtn.addEventListener('click', () => {
    workspace.style.display = 'none';
    dropzone.style.display = 'block';
    fileInput.value = '';
  });

  // Angle selector buttons
  const angleButtons = document.querySelectorAll('.rotate-angle-btn');
  angleButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      angleButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      AppState.rotate.angle = parseInt(btn.getAttribute('data-angle'), 10);
    });
  });

  executeBtn.addEventListener('click', async () => {
    if (!AppState.rotate.sessionId) return;
    executeBtn.disabled = true;
    executeBtn.innerHTML = '<span>⏳</span> Rotating...';

    // Parse pages input if any
    const pagesInput = document.getElementById('rotatePagesInput').value.trim();
    let pageNumbers = null;
    if (pagesInput) {
      pageNumbers = [];
      const parts = pagesInput.split(',');
      parts.forEach(p => {
        p = p.trim();
        if (p.includes('-')) {
          const [s, e] = p.split('-');
          const start = parseInt(s, 10);
          const end = parseInt(e, 10);
          if (!isNaN(start) && !isNaN(end)) {
            for (let i = start; i <= end; i++) pageNumbers.push(i);
          }
        } else {
          const num = parseInt(p, 10);
          if (!isNaN(num)) pageNumbers.push(num);
        }
      });
    }

    try {
      const res = await fetch('/api/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: AppState.rotate.sessionId,
          filename: AppState.rotate.filename,
          angle: AppState.rotate.angle,
          page_numbers: pageNumbers && pageNumbers.length > 0 ? pageNumbers : null,
        }),
      });

      const resData = await res.json();
      if (!res.ok) throw new Error(resData.detail || 'Rotation failed');

      const file = resData.data.files[0];
      showToast('Rotation complete! Downloading...', 'success');
      window.location.href = file.download_url;
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      executeBtn.disabled = false;
      executeBtn.innerHTML = '<span>🔄</span> Apply Rotation & Download';
    }
  });
}

function handleRotateUpload(file) {
  if (!file.name.toLowerCase().endsWith('.pdf')) {
    showToast('Please select a PDF file.', 'error');
    return;
  }

  const formData = new FormData();
  formData.append('file', file);

  fetch('/api/upload', { method: 'POST', body: formData })
    .then(r => r.json())
    .then(data => {
      if (data.success) {
        AppState.rotate.sessionId = data.session_id;
        AppState.rotate.filename = data.filename;
        AppState.rotate.totalPages = data.info.total_pages;

        document.getElementById('rotateDocName').textContent = data.filename;
        document.getElementById('rotateDocSize').textContent = data.info.filesize_display;
        document.getElementById('rotateDocPages').textContent = `${data.info.total_pages} Pages`;

        document.getElementById('rotateDropzone').style.display = 'none';
        document.getElementById('rotateWorkspace').style.display = 'block';
        showToast(`Loaded ${data.filename}`, 'success');
      } else {
        showToast('Upload failed', 'error');
      }
    })
    .catch(err => showToast(err.message, 'error'));
}

// ==========================================================
// Fullscreen Preview Modal
// ==========================================================
function initPreviewModal() {
  const modal = document.getElementById('previewModal');
  const closeBtns = [
    document.getElementById('btnClosePreviewModal'),
    document.getElementById('btnClosePreviewModalBottom'),
  ];
  closeBtns.forEach(btn => {
    btn.addEventListener('click', () => modal.classList.remove('open'));
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.remove('open');
  });

  document.getElementById('btnPrevPreviewPage').addEventListener('click', () => {
    if (AppState.preview.currentPage > 1) {
      openPreviewModal(AppState.preview.currentPage - 1);
    }
  });

  document.getElementById('btnNextPreviewPage').addEventListener('click', () => {
    if (AppState.preview.currentPage < AppState.preview.totalPages) {
      openPreviewModal(AppState.preview.currentPage + 1);
    }
  });
}

async function openPreviewModal(pageNum) {
  if (!AppState.split.pdfDoc) return;
  const modal = document.getElementById('previewModal');
  modal.classList.add('open');

  AppState.preview.currentPage = pageNum;
  AppState.preview.totalPages = AppState.split.totalPages;

  document.getElementById('previewModalTitle').textContent = 
    `Preview: Page ${pageNum} of ${AppState.split.totalPages}`;

  document.getElementById('btnPrevPreviewPage').disabled = pageNum <= 1;
  document.getElementById('btnNextPreviewPage').disabled = pageNum >= AppState.split.totalPages;

  const canvas = document.getElementById('previewModalCanvas');
  try {
    const page = await AppState.split.pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.25 });
    const context = canvas.getContext('2d');
    canvas.height = viewport.height;
    canvas.width = viewport.width;

    await page.render({
      canvasContext: context,
      viewport: viewport,
    }).promise;
  } catch (err) {
    console.error('Modal render error:', err);
  }
}

// Helper: Format bytes
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

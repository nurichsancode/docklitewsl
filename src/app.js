// Global State
let selectedDistro = null;
let activeTab = 'tab-dashboard';
let containersList = [];
let imagesList = [];
let statsPollInterval = null;
let listPollInterval = null;
const loadingContainers = {};

// --- Container detail tab state ---
let openContainerTabs = [];      // [{ id, name }] of open container tabs
let activeContainerTabId = null; // id of the container shown in the detail view
let detailViewActive = false;    // is the detail view currently on screen?
let activeSubTab = 'overview';   // current detail sub-tab
let detailPollInterval = null;   // polls inspect/top for the active container
const logBuffers = {};           // { id: [line, ...] } streamed log lines
const statsHistory = {};         // { id: [{cpu, memPerc, ...}] } rolling samples
const containerInspect = {};     // { id: inspectJson } cached docker inspect
const MAX_LOG_LINES = 1500;      // per-container log line cap
const MAX_STATS_POINTS = 40;     // per-container stats history cap (~2 min)

// Safe Tauri Invoke Fetcher
const invoke = window.__TAURI__
  ? (window.__TAURI__.core ? window.__TAURI__.core.invoke : window.__TAURI__.invoke)
  : null;

// Tauri Event API (for streamed backend -> frontend messages)
const tauriEvent = window.__TAURI__ ? window.__TAURI__.event : null;

// DOM Elements
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const setupScreen = document.getElementById('setup-screen');
const mainLayout = document.getElementById('main-layout');
const wslDistroList = document.getElementById('wsl-distro-list');
const btnConnectWsl = document.getElementById('btn-connect-wsl');
const activeDistroBadge = document.getElementById('active-distro-badge');
const infoDistroName = document.getElementById('info-distro-name');
const infoDistroStatus = document.getElementById('info-distro-status');
const infoDistroVersion = document.getElementById('info-distro-version');
const infoDistroIp = document.getElementById('info-distro-ip');
const runningContainersCount = document.getElementById('running-containers-count');
const imagesCount = document.getElementById('images-count');
const pageTitle = document.getElementById('page-title');
const containersTableBody = document.getElementById('containers-table-body');
const imagesTableBody = document.getElementById('images-table-body');
const liveResourceList = document.getElementById('live-resource-list');

// Stat values
const statTotalContainers = document.getElementById('stat-total-containers');
const statRunningContainers = document.getElementById('stat-running-containers');
const statTotalImages = document.getElementById('stat-total-images');
const statAvgCpu = document.getElementById('stat-avg-cpu');
const statTotalMem = document.getElementById('stat-total-mem');

// Form elements
const deployForm = document.getElementById('deploy-form');
const btnAddEnv = document.getElementById('btn-add-env');
const envVarsContainer = document.getElementById('env-vars-container');

// Global Search Inputs
const searchContainers = document.getElementById('search-containers');
const searchImages = document.getElementById('search-images');
let activeContainerFilter = 'all';

// Initialize on Load
window.addEventListener('DOMContentLoaded', async () => {
  if (!invoke) {
    showError("Application must be run inside Windows Shell / Tauri Desktop!");
    return;
  }

  await checkAppSetup();
  setupEventListeners();
  await setupLogStreamListener();
});

// Show Helper Overlay Loader
function showLoader(text) {
  loadingText.textContent = text;
  loadingOverlay.classList.remove('hidden');
}

function hideLoader() {
  loadingOverlay.classList.add('hidden');
}

function showError(message) {
  hideLoader();
  alert(`[ERROR] ${message}`);
}

// 1. Initial Setup Check
async function checkAppSetup() {
  showLoader("Checking WSL configuration...");
  try {
    const activeDistro = await invoke("get_selected_distro");
    if (activeDistro) {
      selectedDistro = activeDistro;
      setupScreen.classList.add('hidden');
      mainLayout.classList.remove('hidden');
      await loadDistroData();
    } else {
      await showSetupScreen();
    }
  } catch (err) {
    showError(err);
  } finally {
    hideLoader();
  }
}

// Render list of WSL distros for user selection
async function showSetupScreen() {
  mainLayout.classList.add('hidden');
  setupScreen.classList.remove('hidden');
  showLoader("Detecting WSL distros...");
  
  try {
    const status = await invoke("get_wsl_distros");
    const distros = (status && status.distros) || [];
    wslDistroList.innerHTML = '';
    
    if (distros.length === 0) {
      const msg = (status && status.message) || 'No WSL distros detected.';
      wslDistroList.innerHTML = `
        <div class="no-distros">
          <i data-lucide="alert-triangle"></i>
          <p>${msg}</p>
          <p class="no-distros-hint">Open PowerShell as Administrator and run
            <code>wsl --install</code>, restart your computer, then reopen this app.</p>
        </div>
      `;
      btnConnectWsl.disabled = true;
      lucide.createIcons();
      return;
    }

    let selectedItem = null;
    distros.forEach(distro => {
      const item = document.createElement('div');
      item.className = 'distro-item';
      if (distro.is_default) {
        item.classList.add('selected');
        selectedItem = distro.name;
        btnConnectWsl.disabled = false;
      }
      
      item.innerHTML = `
        <div class="distro-info">
          <span class="distro-status-dot ${distro.state.toLowerCase() === 'running' ? 'running' : ''}"></span>
          <span class="distro-name">${distro.name}</span>
          ${distro.is_default ? '<span class="distro-tag">Default</span>' : ''}
        </div>
        <span class="text-sm text-gray-500 font-semibold">WSL v${distro.version}</span>
      `;
      
      item.addEventListener('click', () => {
        document.querySelectorAll('.distro-item').forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');
        selectedItem = distro.name;
        btnConnectWsl.disabled = false;
      });
      
      wslDistroList.appendChild(item);
    });

    // Connect button click
    btnConnectWsl.onclick = async () => {
      if (selectedItem) {
        showLoader(`Connecting to ${selectedItem}...`);
        try {
          await invoke("select_wsl_distro", { distro: selectedItem });
          selectedDistro = selectedItem;
          setupScreen.classList.add('hidden');
          mainLayout.classList.remove('hidden');
          await loadDistroData();
        } catch (err) {
          showError(err);
        } finally {
          hideLoader();
        }
      }
    };

    lucide.createIcons();
  } catch (err) {
    showError(err);
  } finally {
    hideLoader();
  }
}

// 2. Fetch and Load Selected Distro Data
async function loadDistroData() {
  showLoader(`Loading data from distro: ${selectedDistro}...`);
  activeDistroBadge.textContent = selectedDistro;
  infoDistroName.textContent = selectedDistro;
  
  // Clear existing polling
  if (statsPollInterval) clearInterval(statsPollInterval);
  if (listPollInterval) clearInterval(listPollInterval);

  try {
    // 1. Fetch Distro Status Details
    const wslStatus = await invoke("get_wsl_distros");
    const activeDetails = ((wslStatus && wslStatus.distros) || []).find(d => d.name === selectedDistro);
    if (activeDetails) {
      infoDistroStatus.textContent = activeDetails.state;
      infoDistroVersion.textContent = `WSL v${activeDetails.version}`;
    }

    // 2. Refresh Tables
    await refreshContainers();
    await refreshImages();
    
    // 3. Start polling: live stats, plus the container list itself so
    //    status changes (e.g. a container crashing soon after start) show up
    await fetchStats();
    statsPollInterval = setInterval(fetchStats, 3000);
    listPollInterval = setInterval(refreshContainers, 4000);

    lucide.createIcons();
  } catch (err) {
    showError(`Failed to load distro data: ${err}`);
  } finally {
    hideLoader();
  }
}

// Refresh Containers
async function refreshContainers() {
  try {
    const list = await invoke("get_containers", { distro: selectedDistro });
    containersList = list;
    renderContainersTable();
    updateStatCounts();
  } catch (err) {
    console.error("Failed to refresh containers:", err);
  }
}

// Refresh Images
async function refreshImages() {
  try {
    const list = await invoke("get_images", { distro: selectedDistro });
    imagesList = list;
    renderImagesTable();
    updateStatCounts();
  } catch (err) {
    console.error("Failed to refresh images:", err);
  }
}

// Helper to update top stats counts
function updateStatCounts() {
  const total = containersList.length;
  const running = containersList.filter(c => c.State && c.State.toLowerCase() === 'running').length;
  
  statTotalContainers.textContent = total;
  statRunningContainers.textContent = `${running} Active`;
  runningContainersCount.textContent = running;
  
  statTotalImages.textContent = imagesList.length;
  imagesCount.textContent = imagesList.length;
}

// 3. Render Tables
function renderContainersTable() {
  containersTableBody.innerHTML = '';
  
  const query = searchContainers.value.toLowerCase().trim();
  const filtered = containersList.filter(c => {
    // Search query filter
    const nameMatch = c.Names && c.Names.toLowerCase().includes(query);
    const imageMatch = c.Image && c.Image.toLowerCase().includes(query);
    const idMatch = c.ID && c.ID.toLowerCase().includes(query);
    const matchesSearch = nameMatch || imageMatch || idMatch || query === '';
    
    // Category tabs filter
    const isRunning = c.State && c.State.toLowerCase() === 'running';
    if (activeContainerFilter === 'running') {
      return matchesSearch && isRunning;
    } else if (activeContainerFilter === 'exited') {
      return matchesSearch && !isRunning;
    }
    return matchesSearch;
  });

  if (filtered.length === 0) {
    containersTableBody.innerHTML = `
      <tr>
        <td colspan="6" class="text-center text-gray-500 py-8">
          <div class="flex flex-col items-center gap-2">
            <i data-lucide="package-open" style="width: 32px; height: 32px; opacity: 0.3;"></i>
            <p>No containers found.</p>
          </div>
        </td>
      </tr>
    `;
    lucide.createIcons();
    return;
  }

  filtered.forEach(c => {
    const isRunning = c.State && c.State.toLowerCase() === 'running';
    const cleanName = c.Names ? c.Names.replace(/^\//, '') : 'unnamed';
    const statusText = c.Status || c.State || 'Exited';
    
    const isLoading = !!loadingContainers[c.ID];
    const loadingAction = loadingContainers[c.ID];
    
    const row = document.createElement('tr');
    if (isLoading) {
      row.className = 'row-loading-active';
    }
    
    row.innerHTML = `
      <td class="font-semibold">
        <div class="container-name-wrapper">
          <div class="flex items-center gap-2">
            <i data-lucide="box" class="text-gray-400" style="width: 16px; height: 16px;"></i>
            <span class="container-name-link" onclick="openContainerDetail('${c.ID}', '${cleanName}', 'overview')" title="Open container detail">${cleanName}</span>
          </div>
          ${isLoading ? `
            <div class="row-progress-bar">
              <div class="row-progress-fill"></div>
            </div>
          ` : ''}
        </div>
      </td>
      <td class="code-font text-xs text-indigo-300">${c.Image || '-'}</td>
      <td>
        ${isLoading ? `
          <div class="row-loading-container">
            <span class="spinner-mini"></span>
            <span class="capitalize-first">${loadingAction}ing...</span>
          </div>
        ` : `
          <span class="badge ${isRunning ? 'badge-success' : 'badge-danger'}">
            <span class="badge-dot"></span>
            <span>${statusText}</span>
          </span>
        `}
      </td>
      <td>
        ${c.Ports ? `<span class="container-ports code-font">${c.Ports}</span>` : '<span class="text-gray-600">-</span>'}
      </td>
      <td class="text-xs text-gray-400">${c.RunningFor || '-'}</td>
      <td class="text-right">
        <div class="btn-actions-row">
          ${isRunning 
            ? `<button class="btn btn-icon stop-btn" ${isLoading ? 'disabled style="opacity: 0.25; pointer-events: none;"' : ''} onclick="handleContainerAction('${c.ID}', 'stop')" title="Stop Container">
                 <i data-lucide="square"></i>
               </button>`
            : `<button class="btn btn-icon play-btn" ${isLoading ? 'disabled style="opacity: 0.25; pointer-events: none;"' : ''} onclick="handleContainerAction('${c.ID}', 'start')" title="Start Container">
                 <i data-lucide="play"></i>
               </button>`
          }
          <button class="btn btn-icon" ${isLoading ? 'disabled style="opacity: 0.25; pointer-events: none;"' : ''} onclick="handleContainerAction('${c.ID}', 'restart')" title="Restart Container">
            <i data-lucide="refresh-cw"></i>
          </button>
          <button class="btn btn-icon logs-btn" ${isLoading ? 'disabled style="opacity: 0.25; pointer-events: none;"' : ''} onclick="openContainerDetail('${c.ID}', '${cleanName}', 'logs')" title="View Detail & Logs">
            <i data-lucide="terminal"></i>
          </button>
          <button class="btn btn-icon delete-btn" ${isLoading ? 'disabled style="opacity: 0.25; pointer-events: none;"' : ''} onclick="handleContainerAction('${c.ID}', 'delete')" title="Force Delete">
            <i data-lucide="trash-2"></i>
          </button>
        </div>
      </td>
    `;
    
    containersTableBody.appendChild(row);
  });
  
  lucide.createIcons();
}

function renderImagesTable() {
  imagesTableBody.innerHTML = '';
  
  const query = searchImages.value.toLowerCase().trim();
  const filtered = imagesList.filter(img => {
    const repoMatch = img.Repository && img.Repository.toLowerCase().includes(query);
    const tagMatch = img.Tag && img.Tag.toLowerCase().includes(query);
    const idMatch = img.ID && img.ID.toLowerCase().includes(query);
    return repoMatch || tagMatch || idMatch || query === '';
  });

  if (filtered.length === 0) {
    imagesTableBody.innerHTML = `
      <tr>
        <td colspan="6" class="text-center text-gray-500 py-8">
          <div class="flex flex-col items-center gap-2">
            <i data-lucide="copy" style="width: 32px; height: 32px; opacity: 0.3;"></i>
            <p>No images found.</p>
          </div>
        </td>
      </tr>
    `;
    lucide.createIcons();
    return;
  }

  filtered.forEach(img => {
    const shortId = img.ID ? img.ID.replace('sha256:', '').substring(0, 12) : '-';
    
    const row = document.createElement('tr');
    row.innerHTML = `
      <td class="font-semibold text-white">${img.Repository || '<none>'}</td>
      <td><span class="badge badge-indigo">${img.Tag || '<none>'}</span></td>
      <td class="code-font text-xs text-gray-400">${shortId}</td>
      <td class="font-semibold text-cyan-300 text-xs">${img.Size || '-'}</td>
      <td class="text-xs text-gray-400">${img.CreatedSince || '-'}</td>
      <td class="text-right">
        <div class="btn-actions-row">
          <button class="btn btn-icon play-btn" onclick="preFillDeployForm('${img.Repository}:${img.Tag}')" title="Deploy Image">
            <i data-lucide="play-circle"></i>
          </button>
          <button class="btn btn-icon delete-btn" onclick="handleRemoveImage('${img.ID}')" title="Delete Image">
            <i data-lucide="trash-2"></i>
          </button>
        </div>
      </td>
    `;
    
    imagesTableBody.appendChild(row);
  });
  
  lucide.createIcons();
}

// 4. Container Actions
window.handleContainerAction = async (id, action) => {
  let actionText = "";
  switch(action) {
    case 'start': actionText = "Starting container..."; break;
    case 'stop': actionText = "Stopping container..."; break;
    case 'restart': actionText = "Restarting container..."; break;
    case 'delete': actionText = "Deleting container..."; break;
  }
  
  if (action === 'delete') {
    if (!confirm("Are you sure you want to force delete this container?")) return;
    showLoader(actionText);
  } else {
    loadingContainers[id] = action;
    renderContainersTable();
  }
  
  try {
    await invoke("run_container_action", { distro: selectedDistro, id, action });
  } catch (err) {
    showError(`Failed to run container action: ${err}`);
  } finally {
    if (action === 'delete') {
      hideLoader();
    } else {
      delete loadingContainers[id];
    }
    await refreshContainers();
    await fetchStats();
  }
};

// 5. Image Actions
window.handleRemoveImage = async (id) => {
  if (!confirm("Are you sure you want to delete this image?")) return;
  
  showLoader("Deleting docker image...");
  try {
    await invoke("remove_image", { distro: selectedDistro, id });
    await refreshImages();
  } catch (err) {
    showError(`Failed to delete image: ${err}`);
  } finally {
    hideLoader();
  }
};

window.preFillDeployForm = (imageTag) => {
  // Clear existing values in form
  deployForm.reset();
  
  // Fill Image Field
  document.getElementById('deploy-image').value = imageTag;
  
  // Auto-switch to Deploy Tab
  document.getElementById('menu-deploy').click();
};

// 6. Real-Time Resource Stats Polling
async function fetchStats() {
  try {
    const stats = await invoke("get_containers_stats", { distro: selectedDistro });
    
    if (stats.length === 0) {
      liveResourceList.innerHTML = `
        <div class="no-data">
          <i data-lucide="activity"></i>
          <p>No active containers to monitor at this time.</p>
        </div>
      `;
      statAvgCpu.textContent = "0.0%";
      statTotalMem.textContent = "0 MB";
      lucide.createIcons();
      if (detailViewActive && activeSubTab === 'stats') renderStats();
      return;
    }
    
    liveResourceList.innerHTML = '';
    let totalCpu = 0;
    let totalMemUsageBytes = 0;
    
    stats.forEach(stat => {
      const cpuPercStr = stat.CPUPerc ? stat.CPUPerc.replace('%', '') : '0';
      const cpuVal = parseFloat(cpuPercStr) || 0;
      totalCpu += cpuVal;
      
      const memUsageRaw = stat.MemUsage || '0';
      const memPercStr = stat.MemPerc ? stat.MemPerc.replace('%', '') : '0';
      const memPerc = parseFloat(memPercStr) || 0;
      
      // Calculate total memory usage bytes
      const memParts = memUsageRaw.split('/');
      let currentMemValStr = '0MB';
      if (memParts.length > 0) {
        currentMemValStr = memParts[0].trim();
        const bytes = parseMemoryBytes(currentMemValStr);
        totalMemUsageBytes += bytes;
      }

      // Record a sample into the per-container history (open detail tabs only)
      if (statsHistory[stat.ID]) {
        const hist = statsHistory[stat.ID];
        hist.push({
          cpu: cpuVal,
          memPerc: memPerc,
          memUsage: memUsageRaw,
          netIO: stat.NetIO || '-',
          blockIO: stat.BlockIO || '-',
          pids: stat.PIDs || '-'
        });
        if (hist.length > MAX_STATS_POINTS) {
          hist.splice(0, hist.length - MAX_STATS_POINTS);
        }
      }

      const item = document.createElement('div');
      item.className = 'live-stat-item';
      item.innerHTML = `
        <div class="live-stat-meta">
          <span class="stat-name">
            <span class="badge-dot badge-success"></span>
            <span>${stat.Name || 'unnamed'}</span>
          </span>
          <span class="stat-percent">${cpuPercStr}% CPU</span>
        </div>
        <div class="progress-bar-wrapper">
          <div class="progress-bar progress-cyan" style="width: ${Math.min(cpuVal, 100)}%;"></div>
        </div>
        <div class="stat-numbers-row">
          <span>RAM: <span class="stat-num-val">${currentMemValStr}</span> (${memPercStr})</span>
          <span>PIDs: <span class="stat-num-val">${stat.PIDs || '-'}</span></span>
        </div>
      `;
      
      liveResourceList.appendChild(item);
    });
    
    // Update dashboard widgets
    const avgCpu = stats.length > 0 ? (totalCpu / stats.length).toFixed(1) : '0.0';
    statAvgCpu.textContent = `${avgCpu}%`;
    statTotalMem.textContent = formatBytes(totalMemUsageBytes);

    lucide.createIcons();

    // Live-refresh the detail Stats sub-tab if it is on screen
    if (detailViewActive && activeSubTab === 'stats') renderStats();
  } catch (err) {
    console.error("Failed to fetch live stats:", err);
  }
}

// Memory parsing helpers
function parseMemoryBytes(memStr) {
  const match = memStr.match(/^([0-9.]+)\s*([A-Za-z]+)/);
  if (!match) return 0;
  
  const val = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  
  switch(unit) {
    case 'kib': case 'kb': return val * 1024;
    case 'mib': case 'mb': return val * 1024 * 1024;
    case 'gib': case 'gb': return val * 1024 * 1024 * 1024;
    default: return val;
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 MB';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  if (i < 2) return (bytes / (k*k)).toFixed(1) + ' MB'; // lock at MB or higher
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// 7. Container Detail Tabs
// Clicking a container opens a detail tab (listed in the sidebar under
// "Open Containers") with sub-tabs: Overview, Stats, Logs, Config,
// Processes, Exec. Log streams run for every open tab; inspect/top are
// polled only for the container currently shown.

// --- Log streaming: one global listener feeds per-container buffers ---
async function setupLogStreamListener() {
  if (!tauriEvent) return;
  await tauriEvent.listen('log-line', (event) => {
    const payload = event.payload || {};
    if (!payload.id) return;
    appendToBuffer(payload.id, payload.line);
  });
}

function appendToBuffer(id, line) {
  const buffer = logBuffers[id];
  if (!buffer) return;
  buffer.push(line);
  if (buffer.length > MAX_LOG_LINES) {
    buffer.splice(0, buffer.length - MAX_LOG_LINES);
  }
  if (id === activeContainerTabId && detailViewActive && activeSubTab === 'logs') {
    renderLogTerminal();
  }
}

// --- Small formatting helpers ---
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function shortId(id) {
  if (!id) return '-';
  return String(id).replace('sha256:', '').substring(0, 12);
}

function formatDate(str) {
  if (!str) return '-';
  const d = new Date(str);
  if (isNaN(d.getTime()) || d.getFullYear() < 2000) return '-';
  return d.toLocaleString();
}

function firstNetworkIp(net) {
  if (!net || !net.Networks) return null;
  for (const key in net.Networks) {
    const n = net.Networks[key];
    if (n && n.IPAddress) return n.IPAddress;
  }
  return null;
}

function formatPorts(ports) {
  if (!ports) return '-';
  const parts = [];
  for (const containerPort in ports) {
    const bindings = ports[containerPort];
    if (bindings && bindings.length) {
      bindings.forEach(b => parts.push(`${b.HostIp || '0.0.0.0'}:${b.HostPort} -> ${containerPort}`));
    } else {
      parts.push(`${containerPort} (not published)`);
    }
  }
  return parts.length ? parts.join(', ') : '-';
}

// --- Sidebar "Open Containers" tab list ---
function renderContainerTabs() {
  const section = document.getElementById('dynamic-log-menu-section');
  const list = document.getElementById('dynamic-log-tabs-list');

  if (openContainerTabs.length === 0) {
    section.classList.add('hidden');
    list.innerHTML = '';
    return;
  }

  section.classList.remove('hidden');
  list.innerHTML = '';

  openContainerTabs.forEach(tab => {
    const isActive = detailViewActive && tab.id === activeContainerTabId;
    const data = containerInspect[tab.id];
    const running = !!(data && data.State && data.State.Running);

    const item = document.createElement('div');
    item.className = 'log-tab-item' + (isActive ? ' active' : '');
    item.title = tab.name;
    item.innerHTML = `
      <span class="log-tab-stream-dot${running ? '' : ' stopped'}"></span>
      <span class="log-tab-name">${escapeHtml(tab.name)}</span>
      <button class="log-tab-close" title="Close tab">
        <i data-lucide="x"></i>
      </button>
    `;

    item.addEventListener('click', (e) => {
      if (e.target.closest('.log-tab-close')) return;
      switchContainerTab(tab.id);
    });
    item.querySelector('.log-tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      closeContainerTab(tab.id);
    });

    list.appendChild(item);
  });

  lucide.createIcons();
}

// --- Opening / switching / closing container tabs ---

// Called from the container table (row name or terminal icon)
window.openContainerDetail = async (id, name, initialSubTab) => {
  const exists = openContainerTabs.some(t => t.id === id);

  if (!exists) {
    openContainerTabs.push({ id, name });
    logBuffers[id] = [];
    statsHistory[id] = [];
    try {
      await invoke("start_log_stream", { distro: selectedDistro, id, tail: 200 });
    } catch (err) {
      logBuffers[id].push(`[ERROR] Failed to start log stream: ${err}`);
    }
  }

  activeContainerTabId = id;
  activeSubTab = initialSubTab || 'overview';
  detailViewActive = true;

  showDetailView();
  renderContainerTabs();
  await loadInspect(id);
  renderDetailHeader();
  renderContainerTabs();
  applySubTabAvailability();
  switchSubTab(activeSubTab);
  startDetailPolling();
};

function switchContainerTab(id) {
  if (!openContainerTabs.some(t => t.id === id)) return;
  activeContainerTabId = id;
  detailViewActive = true;
  showDetailView();
  renderContainerTabs();
  loadInspect(id).then(() => {
    renderDetailHeader();
    renderContainerTabs();
    applySubTabAvailability();
    switchSubTab(activeSubTab);
  });
  startDetailPolling();
}

async function closeContainerTab(id) {
  try {
    await invoke("stop_log_stream", { id });
  } catch (err) {
    console.error("Failed to stop log stream:", err);
  }

  openContainerTabs = openContainerTabs.filter(t => t.id !== id);
  delete logBuffers[id];
  delete statsHistory[id];
  delete containerInspect[id];

  if (activeContainerTabId === id) {
    if (openContainerTabs.length > 0) {
      switchContainerTab(openContainerTabs[openContainerTabs.length - 1].id);
    } else {
      activeContainerTabId = null;
      detailViewActive = false;
      stopDetailPolling();
      document.getElementById('menu-containers').click();
    }
  }
  renderContainerTabs();
}

// Close every container tab and stop all streams (used when switching distro)
async function closeAllContainerTabs() {
  try {
    await invoke("stop_all_log_streams");
  } catch (err) {
    console.error("Failed to stop log streams:", err);
  }
  openContainerTabs = [];
  for (const k in logBuffers) delete logBuffers[k];
  for (const k in statsHistory) delete statsHistory[k];
  for (const k in containerInspect) delete containerInspect[k];
  activeContainerTabId = null;
  detailViewActive = false;
  stopDetailPolling();
  renderContainerTabs();
}

// --- Detail view shell ---
function showDetailView() {
  document.querySelectorAll('.menu-item').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.add('hidden'));
  document.getElementById('tab-container-detail').classList.remove('hidden');
  const tab = openContainerTabs.find(t => t.id === activeContainerTabId);
  pageTitle.textContent = tab ? `Container: ${tab.name}` : 'Container Detail';
  activeTab = 'tab-container-detail';
}

async function loadInspect(id) {
  try {
    containerInspect[id] = await invoke("inspect_container", { distro: selectedDistro, id });
  } catch (err) {
    containerInspect[id] = null;
    console.error("inspect failed:", err);
  }
}

function isActiveContainerRunning() {
  const data = containerInspect[activeContainerTabId];
  return !!(data && data.State && data.State.Running);
}

function renderDetailHeader() {
  const tab = openContainerTabs.find(t => t.id === activeContainerTabId);
  const data = containerInspect[activeContainerTabId];
  document.getElementById('detail-container-name').textContent = tab ? tab.name : '-';
  document.getElementById('detail-container-id').textContent = activeContainerTabId || '-';

  const running = isActiveContainerRunning();
  const badge = document.getElementById('detail-status-badge');
  let statusText = 'unknown';
  if (data && data.State) {
    statusText = data.State.Status || 'unknown';
    if (!running && typeof data.State.ExitCode === 'number') {
      statusText += ` (exit ${data.State.ExitCode})`;
    }
  }
  badge.textContent = statusText;
  badge.className = 'badge ' + (running ? 'badge-success' : 'badge-danger');

  document.getElementById('detail-btn-start').disabled = running;
  document.getElementById('detail-btn-stop').disabled = !running;
  document.getElementById('detail-btn-restart').disabled = !running;
}

function applySubTabAvailability() {
  const running = isActiveContainerRunning();
  ['stats', 'processes', 'exec'].forEach(name => {
    const btn = document.querySelector(`.detail-subtab[data-subtab="${name}"]`);
    if (btn) btn.classList.toggle('disabled', !running);
  });
  if (!running && ['stats', 'processes', 'exec'].includes(activeSubTab)) {
    // current sub-tab is no longer valid — fall back to Overview
    switchSubTab('overview');
  }
}

// --- Sub-tab switching ---
function switchSubTab(name) {
  const btn = document.querySelector(`.detail-subtab[data-subtab="${name}"]`);
  if (btn && btn.classList.contains('disabled')) return;

  activeSubTab = name;
  document.querySelectorAll('.detail-subtab').forEach(b => {
    b.classList.toggle('active', b.dataset.subtab === name);
  });
  document.querySelectorAll('.detail-pane').forEach(p => p.classList.add('hidden'));
  const pane = document.getElementById('subpane-' + name);
  if (pane) pane.classList.remove('hidden');

  renderActiveSubTab();
}

function renderActiveSubTab() {
  switch (activeSubTab) {
    case 'overview': renderOverview(); break;
    case 'stats': renderStats(); break;
    case 'logs': renderLogTerminal(); break;
    case 'config': renderConfig(); break;
    case 'processes': renderProcesses(); break;
    case 'exec': break; // output persists; nothing to auto-render
  }
}

// --- Overview sub-tab ---
function renderOverview() {
  const grid = document.getElementById('overview-grid');
  const data = containerInspect[activeContainerTabId];
  if (!data) {
    grid.innerHTML = `<p class="config-empty">Could not load container details.</p>`;
    return;
  }

  const state = data.State || {};
  const config = data.Config || {};
  const hostConfig = data.HostConfig || {};
  const net = data.NetworkSettings || {};

  const cmd = Array.isArray(config.Cmd) ? config.Cmd.join(' ') : (config.Cmd || '-');
  const entrypoint = Array.isArray(config.Entrypoint)
    ? config.Entrypoint.join(' ')
    : (config.Entrypoint || '-');
  const restartPolicy = (hostConfig.RestartPolicy && hostConfig.RestartPolicy.Name) || 'no';
  const health = (state.Health && state.Health.Status) || 'n/a';
  const ip = net.IPAddress || firstNetworkIp(net) || '-';

  const items = [
    ['Status', state.Status || '-', state.Running ? 'value-running' : 'value-stopped'],
    ['Exit Code', state.ExitCode != null ? String(state.ExitCode) : '-'],
    ['Health', health],
    ['Image', config.Image || '-'],
    ['Image ID', shortId(data.Image), 'code-font'],
    ['Command', cmd, 'code-font'],
    ['Entrypoint', entrypoint, 'code-font'],
    ['Working Dir', config.WorkingDir || '-', 'code-font'],
    ['Created', formatDate(data.Created)],
    ['Started At', formatDate(state.StartedAt)],
    ['Finished At', formatDate(state.FinishedAt)],
    ['Restart Policy', restartPolicy],
    ['Restart Count', String(data.RestartCount != null ? data.RestartCount : 0)],
    ['Network Mode', hostConfig.NetworkMode || '-'],
    ['IP Address', ip, 'code-font'],
    ['Ports', formatPorts(net.Ports), 'code-font'],
  ];

  grid.innerHTML = items.map(([label, value, cls]) => `
    <div class="info-item">
      <span class="info-label">${label}</span>
      <span class="info-value ${cls || ''}">${escapeHtml(value)}</span>
    </div>
  `).join('');
}

// --- Stats sub-tab ---
function renderStats() {
  const unavailable = document.getElementById('stats-unavailable');
  const content = document.getElementById('stats-content');

  if (!isActiveContainerRunning()) {
    unavailable.classList.remove('hidden');
    content.classList.add('hidden');
    return;
  }
  unavailable.classList.add('hidden');
  content.classList.remove('hidden');

  const history = statsHistory[activeContainerTabId] || [];
  drawSparkline(document.getElementById('chart-cpu'), history.map(s => s.cpu), '#00d9f5');
  drawSparkline(document.getElementById('chart-mem'), history.map(s => s.memPerc), '#8b5cf6', 100);

  const latest = history.length ? history[history.length - 1] : null;
  const nums = document.getElementById('stats-numbers');
  if (latest) {
    const items = [
      ['CPU', `${latest.cpu.toFixed(2)} %`],
      ['Memory Usage', latest.memUsage],
      ['Memory %', `${latest.memPerc.toFixed(2)} %`],
      ['Network I/O', latest.netIO],
      ['Block I/O', latest.blockIO],
      ['PIDs', latest.pids],
    ];
    nums.innerHTML = items.map(([l, v]) => `
      <div class="info-item">
        <span class="info-label">${l}</span>
        <span class="info-value code-font">${escapeHtml(v)}</span>
      </div>`).join('');
  } else {
    nums.innerHTML = `<p class="config-empty">Waiting for the first stats sample...</p>`;
  }
}

function drawSparkline(canvas, rawValues, color, maxHint) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 300;
  const cssH = canvas.clientHeight || 130;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  if (!rawValues.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font = '12px sans-serif';
    ctx.fillText('Collecting data...', 8, cssH / 2);
    return;
  }

  const values = rawValues.length === 1 ? [rawValues[0], rawValues[0]] : rawValues;
  const max = Math.max(maxHint || 0, ...values, 1);
  const padTop = 8, padBottom = 6;
  const plotH = cssH - padTop - padBottom;
  const stepX = cssW / Math.max(values.length - 1, 1);
  const pointY = v => padTop + plotH - (v / max) * plotH;

  ctx.beginPath();
  values.forEach((v, i) => {
    const x = i * stepX;
    const y = pointY(v);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  ctx.lineTo((values.length - 1) * stepX, cssH);
  ctx.lineTo(0, cssH);
  ctx.closePath();
  ctx.fillStyle = color + '22';
  ctx.fill();
}

// --- Logs sub-tab ---
function renderLogTerminal() {
  const buffer = logBuffers[activeContainerTabId];
  if (!buffer) {
    terminalOutput.textContent = "";
    return;
  }
  terminalOutput.textContent = buffer.length
    ? buffer.join('\n')
    : "Connecting to log stream...";
  if (toggleAutoScroll.checked) {
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
  }
}

async function restartLogStream() {
  const id = activeContainerTabId;
  if (!id) return;
  logBuffers[id] = [];
  renderLogTerminal();
  try {
    await invoke("start_log_stream", { distro: selectedDistro, id, tail: 200 });
  } catch (err) {
    logBuffers[id].push(`[ERROR] Failed to restart log stream: ${err}`);
    renderLogTerminal();
  }
}

// --- Config sub-tab ---
function renderConfig() {
  const wrap = document.getElementById('config-content');
  const data = containerInspect[activeContainerTabId];
  if (!data) {
    wrap.innerHTML = `<p class="config-empty">Could not load container details.</p>`;
    return;
  }

  const config = data.Config || {};
  const net = data.NetworkSettings || {};
  const env = Array.isArray(config.Env) ? config.Env : [];
  const mounts = Array.isArray(data.Mounts) ? data.Mounts : [];
  const labels = config.Labels || {};
  const networks = net.Networks || {};

  let html = '';

  // Environment variables (masked by default)
  html += `<div class="config-section">
    <div class="config-section-title">
      <i data-lucide="variable"></i> Environment Variables (${env.length})
      ${env.length ? `<button class="btn btn-sm btn-outline btn-mask-toggle" id="btn-toggle-env-mask">Show values</button>` : ''}
    </div>`;
  if (env.length) {
    html += `<div class="table-responsive"><table class="data-table"><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>`;
    env.forEach(pair => {
      const eq = pair.indexOf('=');
      const key = eq >= 0 ? pair.substring(0, eq) : pair;
      const val = eq >= 0 ? pair.substring(eq + 1) : '';
      html += `<tr><td class="code-font">${escapeHtml(key)}</td>
        <td class="code-font env-value" data-value="${escapeHtml(val)}">&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;</td></tr>`;
    });
    html += `</tbody></table></div>`;
  } else {
    html += `<p class="config-empty">No environment variables.</p>`;
  }
  html += `</div>`;

  // Mounts
  html += `<div class="config-section">
    <div class="config-section-title"><i data-lucide="hard-drive"></i> Mounts (${mounts.length})</div>`;
  if (mounts.length) {
    html += `<div class="table-responsive"><table class="data-table"><thead><tr><th>Type</th><th>Source</th><th>Destination</th><th>Mode</th></tr></thead><tbody>`;
    mounts.forEach(m => {
      html += `<tr>
        <td>${escapeHtml(m.Type || '-')}</td>
        <td class="code-font">${escapeHtml(m.Source || m.Name || '-')}</td>
        <td class="code-font">${escapeHtml(m.Destination || '-')}</td>
        <td>${m.RW ? 'rw' : 'ro'}</td>
      </tr>`;
    });
    html += `</tbody></table></div>`;
  } else {
    html += `<p class="config-empty">No mounts.</p>`;
  }
  html += `</div>`;

  // Networks
  const netNames = Object.keys(networks);
  html += `<div class="config-section">
    <div class="config-section-title"><i data-lucide="network"></i> Networks (${netNames.length})</div>`;
  if (netNames.length) {
    html += `<div class="table-responsive"><table class="data-table"><thead><tr><th>Network</th><th>IP Address</th><th>Gateway</th><th>MAC</th></tr></thead><tbody>`;
    netNames.forEach(name => {
      const n = networks[name] || {};
      html += `<tr>
        <td>${escapeHtml(name)}</td>
        <td class="code-font">${escapeHtml(n.IPAddress || '-')}</td>
        <td class="code-font">${escapeHtml(n.Gateway || '-')}</td>
        <td class="code-font">${escapeHtml(n.MacAddress || '-')}</td>
      </tr>`;
    });
    html += `</tbody></table></div>`;
  } else {
    html += `<p class="config-empty">No networks.</p>`;
  }
  html += `</div>`;

  // Labels
  const labelKeys = Object.keys(labels);
  html += `<div class="config-section">
    <div class="config-section-title"><i data-lucide="tag"></i> Labels (${labelKeys.length})</div>`;
  if (labelKeys.length) {
    html += `<div class="table-responsive"><table class="data-table"><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>`;
    labelKeys.forEach(k => {
      html += `<tr><td class="code-font">${escapeHtml(k)}</td><td class="code-font">${escapeHtml(labels[k])}</td></tr>`;
    });
    html += `</tbody></table></div>`;
  } else {
    html += `<p class="config-empty">No labels.</p>`;
  }
  html += `</div>`;

  // Raw inspect JSON
  html += `<div class="config-section">
    <details class="raw-json-details">
      <summary>Raw inspect JSON</summary>
      <pre class="raw-json-pre">${escapeHtml(JSON.stringify(data, null, 2))}</pre>
    </details>
  </div>`;

  wrap.innerHTML = html;

  const maskBtn = document.getElementById('btn-toggle-env-mask');
  if (maskBtn) {
    maskBtn.addEventListener('click', () => {
      const reveal = maskBtn.textContent === 'Show values';
      document.querySelectorAll('.env-value').forEach(cell => {
        cell.textContent = reveal ? cell.getAttribute('data-value') : '••••••••';
      });
      maskBtn.textContent = reveal ? 'Hide values' : 'Show values';
    });
  }

  lucide.createIcons();
}

// --- Processes sub-tab ---
async function renderProcesses() {
  const wrap = document.getElementById('processes-content');
  const id = activeContainerTabId;
  if (!id) return;

  if (!isActiveContainerRunning()) {
    wrap.innerHTML = `<div class="no-data"><i data-lucide="list-tree"></i><p>Container is not running.</p></div>`;
    lucide.createIcons();
    return;
  }

  try {
    const raw = await invoke("get_container_top", { distro: selectedDistro, id });
    const lines = raw.split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.length);
    if (lines.length === 0) {
      wrap.innerHTML = `<p class="config-empty">No process data.</p>`;
      return;
    }
    const header = lines[0].trim().split(/\s+/);
    let html = `<div class="table-responsive"><table class="data-table"><thead><tr>`;
    header.forEach(h => html += `<th>${escapeHtml(h)}</th>`);
    html += `</tr></thead><tbody>`;
    lines.slice(1).forEach(row => {
      const cols = splitColumns(row, header.length);
      html += `<tr>` + cols.map(c => `<td class="code-font">${escapeHtml(c)}</td>`).join('') + `</tr>`;
    });
    html += `</tbody></table></div>`;
    wrap.innerHTML = html;
  } catch (err) {
    wrap.innerHTML = `<div class="no-data"><i data-lucide="alert-triangle"></i><p>Could not load processes: ${escapeHtml(String(err))}</p></div>`;
    lucide.createIcons();
  }
}

// Split a whitespace-separated row into `count` columns, keeping any
// overflow (e.g. a command with spaces) in the final column.
function splitColumns(line, count) {
  const parts = line.trim().split(/\s+/);
  if (parts.length <= count) return parts;
  const head = parts.slice(0, count - 1);
  head.push(parts.slice(count - 1).join(' '));
  return head;
}

// --- Exec sub-tab ---
async function runExec() {
  const input = document.getElementById('exec-command-input');
  const out = document.getElementById('exec-output');
  const cmd = input.value.trim();
  const id = activeContainerTabId;
  if (!cmd || !id) return;

  if (!isActiveContainerRunning()) {
    out.textContent = "Container is not running.";
    return;
  }

  out.textContent = `$ ${cmd}\n(running...)`;
  try {
    const result = await invoke("exec_in_container", { distro: selectedDistro, id, command: cmd });
    out.textContent = `$ ${cmd}\n\n${result || '(no output)'}`;
  } catch (err) {
    out.textContent = `$ ${cmd}\n\n[ERROR] ${err}`;
  }
}

// --- Container actions (start/stop/restart/delete) ---
// Actions show an inline spinner on the action bar button — never a
// fullscreen loader, since they don't block the rest of the app.
let containerActionInProgress = false;
let actionBarBusyBtnId = null;
let actionBarOriginalHtml = null;

function setActionBarBusy(action) {
  containerActionInProgress = true;
  ['detail-btn-start', 'detail-btn-stop', 'detail-btn-restart', 'detail-btn-delete']
    .forEach(bid => {
      const b = document.getElementById(bid);
      if (b) b.disabled = true;
    });
  const busyLabels = { start: 'Starting', stop: 'Stopping', restart: 'Restarting', delete: 'Deleting' };
  const btn = document.getElementById('detail-btn-' + action);
  if (btn) {
    actionBarBusyBtnId = 'detail-btn-' + action;
    actionBarOriginalHtml = btn.innerHTML;
    btn.innerHTML = `<span class="spinner-mini"></span> ${busyLabels[action]}...`;
  }
}

function clearActionBarBusy() {
  containerActionInProgress = false;
  if (actionBarBusyBtnId) {
    const btn = document.getElementById(actionBarBusyBtnId);
    if (btn && actionBarOriginalHtml != null) {
      btn.innerHTML = actionBarOriginalHtml;
      lucide.createIcons();
    }
    actionBarBusyBtnId = null;
    actionBarOriginalHtml = null;
  }
}

async function detailContainerAction(action) {
  const id = activeContainerTabId;
  if (!id || containerActionInProgress) return;
  if (action === 'delete' && !confirm("Are you sure you want to force delete this container?")) return;

  setActionBarBusy(action);
  try {
    await invoke("run_container_action", { distro: selectedDistro, id, action });
  } catch (err) {
    clearActionBarBusy();
    renderDetailHeader();
    showError(`Action failed: ${err}`);
    return;
  }

  if (action === 'delete') {
    clearActionBarBusy();
    await closeContainerTab(id);
    await refreshContainers();
    return;
  }

  await loadInspect(id);
  clearActionBarBusy();
  renderDetailHeader();
  applySubTabAvailability();
  renderContainerTabs();
  renderActiveSubTab();
  await refreshContainers();
}

// --- Detail polling: only the visible container ---
function startDetailPolling() {
  stopDetailPolling();
  detailPollInterval = setInterval(async () => {
    if (!detailViewActive || !activeContainerTabId) return;
    if (containerActionInProgress) return;
    await loadInspect(activeContainerTabId);
    renderDetailHeader();
    applySubTabAvailability();
    renderContainerTabs();
    if (activeSubTab === 'overview') renderOverview();
    if (activeSubTab === 'processes') renderProcesses();
  }, 5000);
}

function stopDetailPolling() {
  if (detailPollInterval) {
    clearInterval(detailPollInterval);
    detailPollInterval = null;
  }
}

// 8. Event Listeners Setup
function setupEventListeners() {
  // Navigation Tabs switching
  document.querySelectorAll('.menu-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      
      document.querySelectorAll('.menu-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      
      const target = item.getAttribute('data-target');
      document.querySelectorAll('.tab-content').forEach(tab => tab.classList.add('hidden'));
      document.getElementById(target).classList.remove('hidden');
      
      // Update page title
      let title = "Dashboard Overview";
      if (target === 'tab-containers') title = "Containers List";
      else if (target === 'tab-images') title = "Images List";
      else if (target === 'tab-deploy') title = "Deploy New Container";
      pageTitle.textContent = title;

      activeTab = target;

      // Leaving the container detail view
      detailViewActive = false;
      stopDetailPolling();
      renderContainerTabs();
    });
  });

  // Switch Distro Trigger
  document.getElementById('btn-switch-distro').addEventListener('click', () => {
    if (statsPollInterval) clearInterval(statsPollInterval);
    if (listPollInterval) clearInterval(listPollInterval);
    closeAllContainerTabs();
    showSetupScreen();
  });

  // Refresh All button
  document.getElementById('btn-refresh-all').addEventListener('click', async () => {
    showLoader("Refreshing data...");
    await refreshContainers();
    await refreshImages();
    await fetchStats();
    hideLoader();
  });

  // Search input listeners
  searchContainers.addEventListener('input', renderContainersTable);
  searchImages.addEventListener('input', renderImagesTable);

  // Container Filter Buttons
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(el => el.classList.remove('active'));
      btn.classList.add('active');
      activeContainerFilter = btn.getAttribute('data-filter');
      renderContainersTable();
    });
  });

  // Deploy Form Submit
  deployForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const image = document.getElementById('deploy-image').value.trim();
    const name = document.getElementById('deploy-name').value.trim();
    const ports = document.getElementById('deploy-ports').value.trim();
    
    // Gather dynamic env variables
    const envs = [];
    document.querySelectorAll('.env-input').forEach(input => {
      const val = input.value.trim();
      if (val) envs.push(val);
    });
    
    showLoader("Deploying new container...");
    try {
      await invoke("deploy_container", {
        distro: selectedDistro,
        image,
        name,
        ports,
        envs
      });
      
      // Clear Form & Redirect to Containers tab
      deployForm.reset();
      envVarsContainer.innerHTML = `
        <div class="env-row">
          <input type="text" placeholder="KEY=VALUE" class="env-input">
          <button type="button" class="btn btn-icon btn-danger btn-remove-env" disabled>
            <i data-lucide="minus"></i>
          </button>
        </div>
      `;
      lucide.createIcons();
      
      // Switch tab to Containers and Refresh
      document.getElementById('menu-containers').click();
      await refreshContainers();
    } catch (err) {
      showError(`Failed to deploy container: ${err}`);
    } finally {
      hideLoader();
    }
  });

  // Dynamic Add Env Rows
  btnAddEnv.addEventListener('click', () => {
    const row = document.createElement('div');
    row.className = 'env-row';
    row.innerHTML = `
      <input type="text" placeholder="KEY=VALUE" class="env-input">
      <button type="button" class="btn btn-icon btn-danger btn-remove-env">
        <i data-lucide="minus"></i>
      </button>
    `;
    
    row.querySelector('.btn-remove-env').addEventListener('click', () => {
      row.remove();
    });
    
    envVarsContainer.appendChild(row);
    lucide.createIcons();
  });

  // Quick Action: Prune unused Docker data
  document.getElementById('btn-prune').addEventListener('click', async () => {
    if (!confirm("Prune unused Docker data? This removes stopped containers, unused networks, dangling images, and build cache.")) return;

    showLoader("Pruning Docker data...");
    try {
      const result = await invoke("prune_docker", { distro: selectedDistro });
      await refreshContainers();
      await refreshImages();
      hideLoader();

      const reclaimed = (result || '')
        .split('\n')
        .find(line => line.toLowerCase().includes('reclaimed space'));
      alert(reclaimed ? `Prune complete.\n${reclaimed.trim()}` : "Prune complete — nothing to remove.");
    } catch (err) {
      showError(`Failed to prune Docker data: ${err}`);
    }
  });

  document.getElementById('btn-quick-run').addEventListener('click', () => {
    document.getElementById('menu-deploy').click();
  });

  // --- Container detail: sub-tab switching ---
  document.querySelectorAll('.detail-subtab').forEach(btn => {
    btn.addEventListener('click', () => switchSubTab(btn.dataset.subtab));
  });

  // Container detail action buttons
  document.getElementById('detail-btn-start').addEventListener('click', () => detailContainerAction('start'));
  document.getElementById('detail-btn-stop').addEventListener('click', () => detailContainerAction('stop'));
  document.getElementById('detail-btn-restart').addEventListener('click', () => detailContainerAction('restart'));
  document.getElementById('detail-btn-delete').addEventListener('click', () => detailContainerAction('delete'));

  // Sub-tab refresh buttons
  document.getElementById('btn-refresh-overview').addEventListener('click', async () => {
    if (!activeContainerTabId) return;
    await loadInspect(activeContainerTabId);
    renderDetailHeader();
    applySubTabAvailability();
    renderContainerTabs();
    renderOverview();
  });
  document.getElementById('btn-refresh-processes').addEventListener('click', renderProcesses);

  // Logs sub-tab controls
  btnClearLogs.addEventListener('click', () => {
    if (!activeContainerTabId) return;
    logBuffers[activeContainerTabId] = [];
    terminalOutput.textContent = "";
  });
  btnRefreshLogs.addEventListener('click', restartLogStream);

  // Exec sub-tab
  document.getElementById('btn-exec-run').addEventListener('click', runExec);
  document.getElementById('exec-command-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runExec();
  });

  // Sidebar Minimize Toggle Logic (Premium Collapsible Sidebar)
  const sidebar = document.getElementById('app-sidebar');
  const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
  
  if (localStorage.getItem('sidebar-collapsed') === 'true') {
    sidebar.classList.add('collapsed');
  }
  
  btnToggleSidebar.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
    const isCollapsed = sidebar.classList.contains('collapsed');
    localStorage.setItem('sidebar-collapsed', isCollapsed);
  });
}

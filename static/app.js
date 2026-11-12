// Configure PDF.js worker for serverless / GitHub Pages mode
if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

// Application State
const state = {
  mode: "browser",        // "backend" | "browser" (auto-detected)
  jobId: null,
  files: [],              // [{ id, filename, size, pages_count, file?, objectUrl?, pdfDocProxy? }]
  compressedPdfProxy: null,
  compressedBlobUrl: null,
  filename: "",
  originalSize: 0,
  pagesCount: 1,
  imagesCount: 0,
  currentPage: 0,
  hasCompressed: false,
  sizingMode: "target",   // "target" | "preset" | "merge_only"
  colorMode: "color",     // "color" | "grayscale" | "bw"
};

const ICON_BOLT = `
  <svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
  </svg>
`;

const ICON_MERGE = `
  <svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M16 3h5v5"></path>
    <path d="M8 3H3v5"></path>
    <path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3"></path>
    <path d="m15 9 6-6"></path>
  </svg>
`;

const ICON_SPINNER = `
  <svg class="icon icon-sm spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
  </svg>
`;

// DOM Elements
const uploadSection = document.getElementById("uploadSection");
const workspaceSection = document.getElementById("workspaceSection");
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const addMoreFileInput = document.getElementById("addMoreFileInput");
const selectFileBtn = document.getElementById("selectFileBtn");
const addPdfBtn = document.getElementById("addPdfBtn");
const uploadProgressBox = document.getElementById("uploadProgressBox");
const uploadStatusText = document.getElementById("uploadStatusText");
const uploadPercentText = document.getElementById("uploadPercentText");
const uploadProgressBar = document.getElementById("uploadProgressBar");

const fileNameLabel = document.getElementById("fileNameLabel");
const fileMetaLabel = document.getElementById("fileMetaLabel");
const changeFileBtn = document.getElementById("changeFileBtn");
const fileQueueList = document.getElementById("fileQueueList");

const sizingModeTabs = document.getElementById("sizingModeTabs");
const targetSizePanel = document.getElementById("targetSizePanel");
const presetQualityPanel = document.getElementById("presetQualityPanel");
const mergeOnlyPanel = document.getElementById("mergeOnlyPanel");
const compressionSpecificControls = document.getElementById("compressionSpecificControls");

const targetSizeInput = document.getElementById("targetSizeInput");
const targetUnitSelect = document.getElementById("targetUnitSelect");
const targetRatioHint = document.getElementById("targetRatioHint");
const targetPercentSlider = document.getElementById("targetPercentSlider");
const quickTargetChips = document.getElementById("quickTargetChips");

const qualityPresets = document.getElementById("qualityPresets");
const qualitySlider = document.getElementById("qualitySlider");
const qualityValueLabel = document.getElementById("qualityValueLabel");
const dpiSlider = document.getElementById("dpiSlider");
const dpiValueLabel = document.getElementById("dpiValueLabel");

const colorModeGroup = document.getElementById("colorModeGroup");
const bwThresholdBox = document.getElementById("bwThresholdBox");
const bwThresholdSlider = document.getElementById("bwThresholdSlider");
const bwThresholdLabel = document.getElementById("bwThresholdLabel");

const methodSelect = document.getElementById("methodSelect");
const stripMetadataCheck = document.getElementById("stripMetadataCheck");
const stripAnnotationsCheck = document.getElementById("stripAnnotationsCheck");
const preserveTocCheck = document.getElementById("preserveTocCheck");
const compressBtn = document.getElementById("compressBtn");

const resultCard = document.getElementById("resultCard");
const origSizeStat = document.getElementById("origSizeStat");
const newSizeStat = document.getElementById("newSizeStat");
const savingsBadge = document.getElementById("savingsBadge");
const resultDetailsText = document.getElementById("resultDetailsText");
const downloadBtn = document.getElementById("downloadBtn");

const prevPageBtn = document.getElementById("prevPageBtn");
const nextPageBtn = document.getElementById("nextPageBtn");
const pageIndicator = document.getElementById("pageIndicator");
const origPaneTitle = document.getElementById("origPaneTitle");
const origPreviewImg = document.getElementById("origPreviewImg");
const compPreviewImg = document.getElementById("compPreviewImg");
const previewPlaceholder = document.getElementById("previewPlaceholder");
const compressedPaneTitle = document.getElementById("compressedPaneTitle");
const toast = document.getElementById("toast");

// Helpers
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 KB";
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return `${mb.toFixed(mb < 10 ? 2 : 1)} MB`;
  }
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 4500);
}

function cleanupSingleBrowserFile(entry) {
  if (!entry) return;
  if (entry.objectUrl) {
    URL.revokeObjectURL(entry.objectUrl);
    entry.objectUrl = null;
  }
  if (entry.pdfDocProxy) {
    entry.pdfDocProxy.destroy().catch(() => {});
    entry.pdfDocProxy = null;
  }
}

function cleanupBrowserResources() {
  for (const f of state.files) {
    cleanupSingleBrowserFile(f);
  }
  state.files = [];
  if (state.compressedBlobUrl) {
    URL.revokeObjectURL(state.compressedBlobUrl);
    state.compressedBlobUrl = null;
  }
  if (state.compressedPdfProxy) {
    state.compressedPdfProxy.destroy().catch(() => {});
    state.compressedPdfProxy = null;
  }
}

function getActionButtonDefaultHTML() {
  const count = state.files.length;
  if (state.sizingMode === "merge_only") {
    const label = count > 1 ? `Merge ${count} PDFs (Lossless)` : "Save Clean PDF";
    return `${ICON_MERGE}<span>${label}</span>`;
  }
  if (count > 1) {
    return `${ICON_BOLT}<span>Merge &amp; Compress (${count} PDFs)</span>`;
  }
  return `${ICON_BOLT}<span>Compress PDF</span>`;
}

function updateActionButtonLabel() {
  if (!compressBtn.disabled) {
    compressBtn.innerHTML = getActionButtonDefaultHTML();
  }
}

// Target Size Sync Helpers
function setTargetFromRatio(ratio) {
  if (!state.originalSize) return;
  const targetBytes = Math.max(10 * 1024, state.originalSize * ratio);
  const unit = targetUnitSelect.value;
  if (unit === "MB") {
    const mb = targetBytes / (1024 * 1024);
    targetSizeInput.value = mb >= 10 ? mb.toFixed(1) : mb.toFixed(2);
  } else {
    const kb = targetBytes / 1024;
    targetSizeInput.value = Math.round(kb);
  }
  const pct = Math.max(5, Math.min(95, Math.round(ratio * 100)));
  targetPercentSlider.value = pct;
  targetRatioHint.textContent = `~${pct}%`;
}

function updateRatioFromTargetInput() {
  if (!state.originalSize) return;
  const val = parseFloat(targetSizeInput.value) || 0.1;
  const unit = targetUnitSelect.value;
  const targetBytes = unit === "MB" ? val * 1024 * 1024 : val * 1024;
  const ratio = targetBytes / state.originalSize;
  const pct = Math.max(1, Math.min(100, Math.round(ratio * 100)));
  targetPercentSlider.value = Math.max(5, Math.min(95, pct));
  targetRatioHint.textContent = `~${pct}%`;
}

// Upload & Add File Events
selectFileBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  fileInput.click();
});

dropzone.addEventListener("click", () => fileInput.click());

dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("dragover");
});

dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    handleFilesSelection(Array.from(e.dataTransfer.files), false);
  }
});

fileInput.addEventListener("change", () => {
  if (fileInput.files && fileInput.files.length > 0) {
    handleFilesSelection(Array.from(fileInput.files), false);
  }
});

addPdfBtn.addEventListener("click", () => {
  addMoreFileInput.value = "";
  addMoreFileInput.click();
});

addMoreFileInput.addEventListener("change", () => {
  if (addMoreFileInput.files && addMoreFileInput.files.length > 0) {
    handleFilesSelection(Array.from(addMoreFileInput.files), true);
  }
});

changeFileBtn.addEventListener("click", () => {
  if (state.mode === "backend" && state.jobId) {
    fetch(`./api/job/${state.jobId}`, { method: "DELETE" }).catch(() => {});
  }
  cleanupBrowserResources();
  state.jobId = null;
  fileInput.value = "";
  workspaceSection.classList.add("hidden");
  uploadSection.classList.remove("hidden");
  uploadProgressBox.classList.add("hidden");
});

async function handleFilesSelection(fileArray, append = false) {
  const pdfFiles = fileArray.filter((f) => f.name.toLowerCase().endsWith(".pdf"));
  if (pdfFiles.length === 0) {
    showToast("Please select valid PDF file(s) (.pdf)");
    return;
  }

  if (!append) {
    cleanupBrowserResources();
    state.jobId = null;
    uploadProgressBox.classList.remove("hidden");
    uploadProgressBar.style.width = "10%";
    uploadPercentText.textContent = "10%";
    uploadStatusText.textContent = `Loading ${pdfFiles.length} PDF file(s)...`;
  } else {
    addPdfBtn.disabled = true;
  }

  const isLocalServer =
    window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";

  try {
    if (isLocalServer && (!append || state.mode === "backend")) {
      let lastData = null;
      let backendOk = true;
      for (let i = 0; i < pdfFiles.length; i++) {
        const resData = await tryBackendUpload(pdfFiles[i], state.jobId);
        if (!resData) {
          backendOk = false;
          break;
        }
        state.jobId = resData.job_id;
        lastData = resData;
      }
      if (backendOk && lastData) {
        state.mode = "backend";
        applyJobStateFromBackend(lastData, !append);
        return;
      }
    }

    // Browser Mode (GitHub Pages / Serverless)
    state.mode = "browser";
    await appendFilesInBrowser(pdfFiles, !append);
  } finally {
    addPdfBtn.disabled = false;
  }
}

function tryBackendUpload(file, existingJobId = null) {
  return new Promise((resolve) => {
    const formData = new FormData();
    formData.append("file", file);

    const url = existingJobId
      ? `./api/upload?job_id=${encodeURIComponent(existingJobId)}`
      : "./api/upload";

    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && !uploadProgressBox.classList.contains("hidden")) {
        const pct = Math.round((e.loaded / e.total) * 100);
        uploadProgressBar.style.width = `${pct}%`;
        uploadPercentText.textContent = `${pct}%`;
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
          return;
        } catch (_) {}
      }
      resolve(null);
    };

    xhr.onerror = () => resolve(null);
    xhr.send(formData);
  });
}

async function appendFilesInBrowser(pdfFiles, isInitial) {
  try {
    for (let i = 0; i < pdfFiles.length; i++) {
      const f = pdfFiles[i];
      if (!uploadProgressBox.classList.contains("hidden")) {
        const pct = Math.round(((i + 0.5) / pdfFiles.length) * 100);
        uploadProgressBar.style.width = `${pct}%`;
        uploadPercentText.textContent = `${pct}%`;
        uploadStatusText.textContent = `Opening "${f.name}"...`;
      }

      const objectUrl = URL.createObjectURL(f);
      const pdfDocProxy = await window.pdfjsLib.getDocument({
        url: objectUrl,
        disableAutoFetch: true,
        disableStream: false,
      }).promise;

      state.files.push({
        id: `f_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        file: f,
        filename: f.name,
        size: f.size,
        pages_count: pdfDocProxy.numPages,
        objectUrl,
        pdfDocProxy,
      });
    }

    state.jobId = "browser-session";
    recalculateBrowserTotals(isInitial);
  } catch (err) {
    showToast(`Failed to open PDF: ${err.message || err}`);
    uploadProgressBox.classList.add("hidden");
  }
}

function recalculateBrowserTotals(resetTargetRatio = false) {
  state.originalSize = state.files.reduce((acc, f) => acc + f.size, 0);
  state.pagesCount = Math.max(1, state.files.reduce((acc, f) => acc + f.pages_count, 0));
  state.imagesCount = state.pagesCount;
  if (state.files.length === 1) {
    state.filename = state.files[0].filename;
  } else if (state.files.length > 1) {
    const first = state.files[0].filename;
    const stem = first.toLowerCase().endsWith(".pdf") ? first.slice(0, -4) : first;
    state.filename = `${stem}_merged_${state.files.length}_files.pdf`;
  }

  refreshWorkspaceUI(resetTargetRatio);
}

function applyJobStateFromBackend(data, resetTargetRatio = false) {
  state.jobId = data.job_id;
  state.filename = data.filename;
  state.originalSize = data.original_size;
  state.pagesCount = data.pages_count;
  state.imagesCount = data.images_count;
  state.files = data.files || [];

  refreshWorkspaceUI(resetTargetRatio);
}

function refreshWorkspaceUI(resetTargetRatio = false) {
  if (state.currentPage >= state.pagesCount) {
    state.currentPage = Math.max(0, state.pagesCount - 1);
  }
  state.hasCompressed = false;

  if (state.files.length > 1) {
    fileNameLabel.textContent = `${state.files.length} PDF files to merge`;
    fileNameLabel.title = state.files.map((f) => f.filename).join(" + ");
  } else {
    fileNameLabel.textContent = state.filename;
    fileNameLabel.title = state.filename;
  }
  fileMetaLabel.textContent = `${formatBytes(state.originalSize)} • ${state.pagesCount} pages total`;

  if (resetTargetRatio) {
    if (state.originalSize < 1024 * 1024) {
      targetUnitSelect.value = "KB";
    } else {
      targetUnitSelect.value = "MB";
    }
    setTargetFromRatio(0.5);
  } else {
    updateRatioFromTargetInput();
  }

  renderFileQueueList();
  updateActionButtonLabel();

  resultCard.classList.add("hidden");
  compPreviewImg.classList.add("hidden");
  previewPlaceholder.classList.remove("hidden");
  compressedPaneTitle.textContent = "Output (click action button)";

  uploadSection.classList.add("hidden");
  workspaceSection.classList.remove("hidden");

  updatePaginationUI();
  loadPreviews();
}

function renderFileQueueList() {
  if (state.files.length <= 1) {
    fileQueueList.classList.add("hidden");
    fileQueueList.innerHTML = "";
    return;
  }

  fileQueueList.classList.remove("hidden");
  fileQueueList.innerHTML = state.files
    .map(
      (f, idx) => `
      <div class="queue-item" data-id="${f.id}">
        <div class="queue-item-left">
          <span class="queue-index">${idx + 1}</span>
          <div class="queue-info">
            <div class="queue-name" title="${f.filename}">${f.filename}</div>
            <div class="queue-sub">${formatBytes(f.size)} • ${f.pages_count} p.</div>
          </div>
        </div>
        <div class="queue-actions">
          <button type="button" class="queue-btn" data-action="up" data-idx="${idx}" ${
        idx === 0 ? "disabled" : ""
      } title="Move up">
            <svg class="icon icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="18 15 12 9 6 15"></polyline>
            </svg>
          </button>
          <button type="button" class="queue-btn" data-action="down" data-idx="${idx}" ${
        idx === state.files.length - 1 ? "disabled" : ""
      } title="Move down">
            <svg class="icon icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
          <button type="button" class="queue-btn danger" data-action="remove" data-idx="${idx}" title="Remove file">
            <svg class="icon icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>
    `
    )
    .join("");
}

fileQueueList.addEventListener("click", async (e) => {
  const btn = e.target.closest(".queue-btn");
  if (!btn || btn.disabled) return;

  const action = btn.dataset.action;
  const idx = parseInt(btn.dataset.idx, 10);
  if (isNaN(idx) || idx < 0 || idx >= state.files.length) return;

  if (action === "up" && idx > 0) {
    const tmp = state.files[idx - 1];
    state.files[idx - 1] = state.files[idx];
    state.files[idx] = tmp;
  } else if (action === "down" && idx < state.files.length - 1) {
    const tmp = state.files[idx + 1];
    state.files[idx + 1] = state.files[idx];
    state.files[idx] = tmp;
  } else if (action === "remove") {
    if (state.files.length <= 1) return;
    const [removed] = state.files.splice(idx, 1);
    if (state.mode === "browser") {
      cleanupSingleBrowserFile(removed);
    }
  }

  if (state.mode === "backend") {
    try {
      const res = await fetch(`./api/queue/${state.jobId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_ids: state.files.map((f) => f.id) }),
      });
      if (res.ok) {
        const data = await res.json();
        applyJobStateFromBackend(data, false);
      }
    } catch (err) {
      showToast("Failed to update queue order");
    }
  } else {
    recalculateBrowserTotals(false);
  }
});

// Sizing / Operation Mode Tabs
sizingModeTabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  sizingModeTabs.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  state.sizingMode = btn.dataset.mode;

  targetSizePanel.classList.toggle("hidden", state.sizingMode !== "target");
  presetQualityPanel.classList.toggle("hidden", state.sizingMode !== "preset");
  mergeOnlyPanel.classList.toggle("hidden", state.sizingMode !== "merge_only");
  compressionSpecificControls.classList.toggle("hidden", state.sizingMode === "merge_only");

  updateActionButtonLabel();
});

// Target Size Controls
targetPercentSlider.addEventListener("input", () => {
  const ratio = parseInt(targetPercentSlider.value, 10) / 100;
  quickTargetChips.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
  setTargetFromRatio(ratio);
});

targetSizeInput.addEventListener("input", () => {
  quickTargetChips.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
  updateRatioFromTargetInput();
});

targetUnitSelect.addEventListener("change", () => {
  const pct = parseInt(targetPercentSlider.value, 10) / 100;
  setTargetFromRatio(pct);
});

quickTargetChips.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  quickTargetChips.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
  chip.classList.add("active");

  if (chip.dataset.ratio) {
    setTargetFromRatio(parseFloat(chip.dataset.ratio));
  } else if (chip.dataset.mb) {
    targetUnitSelect.value = "MB";
    targetSizeInput.value = chip.dataset.mb;
    updateRatioFromTargetInput();
  }
});

// Preset & Manual Quality Controls
qualityPresets.addEventListener("click", (e) => {
  const card = e.target.closest(".preset-card");
  if (!card) return;
  qualityPresets.querySelectorAll(".preset-card").forEach((c) => c.classList.remove("active"));
  card.classList.add("active");

  qualitySlider.value = card.dataset.q;
  dpiSlider.value = card.dataset.dpi;
  qualityValueLabel.textContent = `${card.dataset.q}%`;
  dpiValueLabel.textContent = `${card.dataset.dpi} DPI`;
});

qualitySlider.addEventListener("input", () => {
  qualityValueLabel.textContent = `${qualitySlider.value}%`;
  qualityPresets.querySelectorAll(".preset-card").forEach((c) => c.classList.remove("active"));
});

dpiSlider.addEventListener("input", () => {
  dpiValueLabel.textContent = `${dpiSlider.value} DPI`;
  qualityPresets.querySelectorAll(".preset-card").forEach((c) => c.classList.remove("active"));
});

// Color Mode Controls
colorModeGroup.addEventListener("click", (e) => {
  const card = e.target.closest(".color-card");
  if (!card) return;
  colorModeGroup.querySelectorAll(".color-card").forEach((c) => c.classList.remove("active"));
  card.classList.add("active");
  state.colorMode = card.dataset.color;

  if (state.colorMode === "bw") {
    bwThresholdBox.classList.remove("hidden");
  } else {
    bwThresholdBox.classList.add("hidden");
  }
});

bwThresholdSlider.addEventListener("input", () => {
  bwThresholdLabel.textContent = bwThresholdSlider.value;
});

// ============================================================================
// In-Browser PDF Merge & Compression Engine (PDF.js + Canvas + pdf-lib)
// ============================================================================

function resolveGlobalPageInBrowser(globalPageIndex0Based) {
  let offset = 0;
  for (const entry of state.files) {
    if (globalPageIndex0Based < offset + entry.pages_count) {
      return {
        entry,
        localPage1Based: globalPageIndex0Based - offset + 1,
      };
    }
    offset += entry.pages_count;
  }
  const last = state.files[state.files.length - 1];
  return {
    entry: last,
    localPage1Based: last ? last.pages_count : 1,
  };
}

function applyCanvasColorMode(ctx, width, height, colorMode, bwThreshold) {
  if (colorMode === "color") return;

  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;

  if (colorMode === "grayscale") {
    for (let i = 0; i < data.length; i += 4) {
      const lum = (77 * data[i] + 150 * data[i + 1] + 29 * data[i + 2]) >> 8;
      data[i] = lum;
      data[i + 1] = lum;
      data[i + 2] = lum;
    }
  } else if (colorMode === "bw") {
    let minL = 255;
    let maxL = 0;
    for (let i = 0; i < data.length; i += 16) {
      const lum = (77 * data[i] + 150 * data[i + 1] + 29 * data[i + 2]) >> 8;
      if (lum < minL) minL = lum;
      if (lum > maxL) maxL = lum;
    }
    const range = Math.max(1, maxL - minL);
    for (let i = 0; i < data.length; i += 4) {
      const lum = (77 * data[i] + 150 * data[i + 1] + 29 * data[i + 2]) >> 8;
      const norm = ((lum - minL) * 255) / range;
      const val = norm >= bwThreshold ? 255 : 0;
      data[i] = val;
      data[i + 1] = val;
      data[i + 2] = val;
    }
  }

  ctx.putImageData(imgData, 0, 0);
}

async function renderGlobalPageToJpegBytes(globalPageIdx0Based, dpi, quality, colorMode, bwThreshold) {
  const { entry, localPage1Based } = resolveGlobalPageInBrowser(globalPageIdx0Based);
  const page = await entry.pdfDocProxy.getPage(localPage1Based);
  const baseViewport = page.getViewport({ scale: 1.0 });
  const scale = Math.max(36, dpi) / 72.0;
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));

  const ctx = canvas.getContext("2d", { willReadFrequently: colorMode !== "color" });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: ctx, viewport }).promise;
  applyCanvasColorMode(ctx, canvas.width, canvas.height, colorMode, bwThreshold);

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", Math.max(0.05, Math.min(0.95, quality / 100)))
  );
  const arrayBuf = await blob.arrayBuffer();
  return {
    jpegBytes: new Uint8Array(arrayBuf),
    ptWidth: baseViewport.width,
    ptHeight: baseViewport.height,
  };
}

async function solveBrowserTargetParams(targetBytes, colorMode, bwThreshold) {
  const numPages = state.pagesCount;
  const sampleIndices = [];
  if (numPages <= 3) {
    for (let i = 0; i < numPages; i++) sampleIndices.push(i);
  } else {
    sampleIndices.push(0);
    sampleIndices.push(Math.floor(numPages / 2));
    sampleIndices.push(numPages - 1);
  }

  const candidates = [
    [200, 85],
    [175, 80],
    [150, 75],
    [135, 70],
    [120, 65],
    [105, 58],
    [92, 52],
    [80, 45],
    [68, 38],
    [56, 30],
    [45, 22],
    [36, 15],
  ];

  let low = 0;
  let high = candidates.length - 1;
  let bestIdx = high;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const [dpi, qual] = candidates[mid];
    let sampleSum = 0;
    for (const gIdx of sampleIndices) {
      const { jpegBytes } = await renderGlobalPageToJpegBytes(
        gIdx,
        dpi,
        qual,
        colorMode,
        bwThreshold
      );
      sampleSum += jpegBytes.byteLength + 900;
    }
    const estTotal = (sampleSum / sampleIndices.length) * numPages + 2048;
    if (estTotal <= targetBytes * 0.93) {
      bestIdx = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return candidates[bestIdx];
}

async function mergeOnlyInBrowser(payload) {
  const t0 = performance.now();
  const outPdf = await window.PDFLib.PDFDocument.create();

  for (let i = 0; i < state.files.length; i++) {
    const entry = state.files[i];
    compressBtn.innerHTML = `${ICON_SPINNER}<span>Merging file ${i + 1} of ${state.files.length}...</span>`;
    const buf = await entry.file.arrayBuffer();
    const srcDoc = await window.PDFLib.PDFDocument.load(buf, { ignoreEncryption: true });
    const copiedPages = await outPdf.copyPages(srcDoc, srcDoc.getPageIndices());
    for (const p of copiedPages) {
      outPdf.addPage(p);
    }
  }

  if (payload.strip_metadata) {
    outPdf.setTitle("");
    outPdf.setAuthor("");
    outPdf.setSubject("");
    outPdf.setKeywords([]);
    outPdf.setProducer("");
    outPdf.setCreator("");
  }

  const pdfBytes = await outPdf.save({ useObjectStreams: true });
  return await finalizeBrowserOutput(pdfBytes, t0, "merge_only", "color", 300, 100);
}

async function compressInBrowser(payload) {
  if (payload.method === "merge_only") {
    return await mergeOnlyInBrowser(payload);
  }

  const t0 = performance.now();
  const numPages = state.pagesCount;

  let dpiUsed = payload.dpi;
  let qualityUsed = payload.quality;

  if (payload.target_size_kb && payload.target_size_kb > 0) {
    compressBtn.innerHTML = `${ICON_SPINNER}<span>Calculating optimal parameters...</span>`;
    const targetBytes = payload.target_size_kb * 1024;
    const [optDpi, optQ] = await solveBrowserTargetParams(
      targetBytes,
      payload.color_mode,
      payload.bw_threshold
    );
    dpiUsed = optDpi;
    qualityUsed = optQ;
  }

  const outPdf = await window.PDFLib.PDFDocument.create();
  if (payload.strip_metadata) {
    outPdf.setTitle("");
    outPdf.setAuthor("");
    outPdf.setSubject("");
    outPdf.setKeywords([]);
    outPdf.setProducer("");
    outPdf.setCreator("");
  }

  for (let gIdx = 0; gIdx < numPages; gIdx++) {
    const pct = Math.round(((gIdx + 1) / numPages) * 100);
    compressBtn.innerHTML = `${ICON_SPINNER}<span>Processing ${pct}% (${gIdx + 1}/${numPages})...</span>`;

    const { jpegBytes, ptWidth, ptHeight } = await renderGlobalPageToJpegBytes(
      gIdx,
      dpiUsed,
      qualityUsed,
      payload.color_mode,
      payload.bw_threshold
    );

    const jpgImage = await outPdf.embedJpg(jpegBytes);
    const page = outPdf.addPage([ptWidth, ptHeight]);
    page.drawImage(jpgImage, {
      x: 0,
      y: 0,
      width: ptWidth,
      height: ptHeight,
    });
  }

  const pdfBytes = await outPdf.save({ useObjectStreams: true });
  return await finalizeBrowserOutput(
    pdfBytes,
    t0,
    "rasterize",
    payload.color_mode,
    dpiUsed,
    qualityUsed
  );
}

async function finalizeBrowserOutput(pdfBytes, t0, methodUsed, colorMode, dpiUsed, qualityUsed) {
  const compressedSize = pdfBytes.byteLength;

  if (state.compressedBlobUrl) {
    URL.revokeObjectURL(state.compressedBlobUrl);
  }
  if (state.compressedPdfProxy) {
    await state.compressedPdfProxy.destroy().catch(() => {});
  }

  const blob = new Blob([pdfBytes], { type: "application/pdf" });
  state.compressedBlobUrl = URL.createObjectURL(blob);
  state.compressedPdfProxy = await window.pdfjsLib.getDocument({
    url: state.compressedBlobUrl,
  }).promise;

  const elapsedSec = ((performance.now() - t0) / 1000).toFixed(2);
  const savedBytes = Math.max(0, state.originalSize - compressedSize);
  const reductionPercent = Number(
    ((1.0 - compressedSize / Math.max(1, state.originalSize)) * 100).toFixed(1)
  );

  return {
    original_size: state.originalSize,
    compressed_size: compressedSize,
    saved_bytes: savedBytes,
    reduction_percent: reductionPercent,
    method_used: methodUsed,
    color_mode: colorMode,
    dpi_used: dpiUsed,
    quality_used: qualityUsed,
    elapsed_sec: elapsedSec,
  };
}

// Execute Compress / Merge
compressBtn.addEventListener("click", async () => {
  if (!state.jobId) return;

  compressBtn.disabled = true;
  compressBtn.innerHTML = `${ICON_SPINNER}<span>Processing PDF...</span>`;

  let targetSizeKb = null;
  if (state.sizingMode === "target") {
    const rawVal = Math.max(0.01, parseFloat(targetSizeInput.value) || 1);
    targetSizeKb = targetUnitSelect.value === "MB" ? rawVal * 1024 : rawVal;
  }

  const chosenMethod =
    state.sizingMode === "merge_only" ? "merge_only" : methodSelect.value;

  const payload = {
    job_id: state.jobId,
    method: chosenMethod,
    color_mode: state.colorMode,
    quality: parseInt(qualitySlider.value, 10),
    dpi: parseInt(dpiSlider.value, 10),
    target_size_kb: targetSizeKb,
    bw_threshold: parseInt(bwThresholdSlider.value, 10),
    strip_metadata: stripMetadataCheck.checked,
    strip_annotations: stripAnnotationsCheck.checked,
    preserve_toc: preserveTocCheck.checked,
  };

  try {
    let data;
    if (state.mode === "backend") {
      const res = await fetch("./api/compress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || "Processing failed");
      }
      data = await res.json();
    } else {
      data = await compressInBrowser(payload);
    }

    state.hasCompressed = true;
    renderResultStats(data);
    await loadPreviews();
  } catch (err) {
    showToast(err.message || "Error processing PDF");
  } finally {
    compressBtn.disabled = false;
    updateActionButtonLabel();
  }
});

function renderResultStats(data) {
  resultCard.classList.remove("hidden");
  origSizeStat.textContent = formatBytes(data.original_size);
  newSizeStat.textContent = formatBytes(data.compressed_size);

  const reduction = data.reduction_percent;
  if (data.method_used === "merge_only" && Math.abs(reduction) < 2) {
    savingsBadge.textContent = "Lossless";
  } else if (reduction >= 0) {
    savingsBadge.textContent = `-${reduction}%`;
  } else {
    savingsBadge.textContent = `+${Math.abs(reduction)}%`;
  }

  const methodNames = {
    smart: "Smart (Selectable Text)",
    rasterize: "Optimized Stream",
    merge_only: "Lossless Merge",
  };
  const colorNames = {
    color: "Color (RGB)",
    grayscale: "Grayscale",
    bw: "Black & White",
  };

  if (data.method_used === "merge_only") {
    resultDetailsText.textContent =
      `Merged ${state.files.length} file(s) (${state.pagesCount} pages) • ` +
      `Engine: Lossless Merge • Time: ${data.elapsed_sec}s`;
  } else {
    resultDetailsText.textContent =
      `Saved: ${formatBytes(data.saved_bytes)} • ` +
      `Engine: ${methodNames[data.method_used] || data.method_used} • ` +
      `Mode: ${colorNames[data.color_mode] || data.color_mode} • ` +
      `${data.dpi_used} DPI • Quality: ${data.quality_used}% • ` +
      `Time: ${data.elapsed_sec}s`;
  }

  const stem = state.filename.toLowerCase().endsWith(".pdf")
    ? state.filename.slice(0, -4)
    : state.filename;
  const downloadFilename = stem.includes("_merged_")
    ? `${stem}.pdf`
    : `${stem}_compressed.pdf`;
  downloadBtn.setAttribute("download", downloadFilename);

  if (state.mode === "backend") {
    downloadBtn.href = `./api/download/${state.jobId}?t=${Date.now()}`;
  } else {
    downloadBtn.href = state.compressedBlobUrl;
  }

  compressedPaneTitle.textContent = `Output (${formatBytes(data.compressed_size)})`;
}

// Page Preview Pagination
prevPageBtn.addEventListener("click", () => {
  if (state.currentPage > 0) {
    state.currentPage--;
    updatePaginationUI();
    loadPreviews();
  }
});

nextPageBtn.addEventListener("click", () => {
  if (state.currentPage < state.pagesCount - 1) {
    state.currentPage++;
    updatePaginationUI();
    loadPreviews();
  }
});

function updatePaginationUI() {
  pageIndicator.textContent = `Page ${state.currentPage + 1} of ${state.pagesCount}`;
  prevPageBtn.disabled = state.currentPage <= 0;
  nextPageBtn.disabled = state.currentPage >= state.pagesCount - 1;
}

async function renderProxyPageToDataUrl(pdfProxy, pageIndex1Based, dpi = 110) {
  const page = await pdfProxy.getPage(pageIndex1Based);
  const viewport = page.getViewport({ scale: dpi / 72.0 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toDataURL("image/png");
}

async function loadPreviews() {
  if (!state.jobId) return;

  if (state.mode === "backend") {
    const ts = Date.now();
    origPaneTitle.textContent =
      state.files.length > 1
        ? `Original (Combined Queue — Page ${state.currentPage + 1})`
        : "Original";
    origPreviewImg.src = `./api/preview/${state.jobId}?variant=original&page=${state.currentPage}&t=${ts}`;

    if (state.hasCompressed) {
      previewPlaceholder.classList.add("hidden");
      compPreviewImg.classList.remove("hidden");
      compPreviewImg.src = `./api/preview/${state.jobId}?variant=compressed&page=${state.currentPage}&t=${ts}`;
    }
  } else {
    if (state.files.length > 0) {
      const { entry, localPage1Based } = resolveGlobalPageInBrowser(state.currentPage);
      origPaneTitle.textContent =
        state.files.length > 1
          ? `Original (${entry.filename} — p. ${localPage1Based})`
          : "Original";
      origPreviewImg.src = await renderProxyPageToDataUrl(entry.pdfDocProxy, localPage1Based);
    }
    if (state.hasCompressed && state.compressedPdfProxy) {
      previewPlaceholder.classList.add("hidden");
      compPreviewImg.classList.remove("hidden");
      compPreviewImg.src = await renderProxyPageToDataUrl(
        state.compressedPdfProxy,
        state.currentPage + 1
      );
    }
  }
}

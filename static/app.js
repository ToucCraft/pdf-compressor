// Configure PDF.js worker for serverless / GitHub Pages mode
if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

// Application State
const state = {
  mode: "browser",        // "backend" | "browser" (auto-detected)
  jobId: null,
  file: null,
  fileObjectUrl: null,
  pdfDocProxy: null,      // PDF.js document proxy for browser mode
  compressedPdfProxy: null,
  compressedBlobUrl: null,
  filename: "",
  originalSize: 0,
  pagesCount: 1,
  imagesCount: 0,
  currentPage: 0,
  hasCompressed: false,
  sizingMode: "target",   // "target" | "preset"
  colorMode: "color",     // "color" | "grayscale" | "bw"
};

const ICON_BOLT = `
  <svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
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
const selectFileBtn = document.getElementById("selectFileBtn");
const uploadProgressBox = document.getElementById("uploadProgressBox");
const uploadStatusText = document.getElementById("uploadStatusText");
const uploadPercentText = document.getElementById("uploadPercentText");
const uploadProgressBar = document.getElementById("uploadProgressBar");

const fileNameLabel = document.getElementById("fileNameLabel");
const fileMetaLabel = document.getElementById("fileMetaLabel");
const changeFileBtn = document.getElementById("changeFileBtn");

const sizingModeTabs = document.getElementById("sizingModeTabs");
const targetSizePanel = document.getElementById("targetSizePanel");
const presetQualityPanel = document.getElementById("presetQualityPanel");

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

function cleanupBrowserResources() {
  if (state.fileObjectUrl) {
    URL.revokeObjectURL(state.fileObjectUrl);
    state.fileObjectUrl = null;
  }
  if (state.compressedBlobUrl) {
    URL.revokeObjectURL(state.compressedBlobUrl);
    state.compressedBlobUrl = null;
  }
  if (state.pdfDocProxy) {
    state.pdfDocProxy.destroy().catch(() => {});
    state.pdfDocProxy = null;
  }
  if (state.compressedPdfProxy) {
    state.compressedPdfProxy.destroy().catch(() => {});
    state.compressedPdfProxy = null;
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

// Upload File Logic
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
    handleFileSelection(e.dataTransfer.files[0]);
  }
});

fileInput.addEventListener("change", () => {
  if (fileInput.files && fileInput.files.length > 0) {
    handleFileSelection(fileInput.files[0]);
  }
});

changeFileBtn.addEventListener("click", () => {
  if (state.mode === "backend" && state.jobId) {
    fetch(`./api/job/${state.jobId}`, { method: "DELETE" }).catch(() => {});
  }
  cleanupBrowserResources();
  fileInput.value = "";
  workspaceSection.classList.add("hidden");
  uploadSection.classList.remove("hidden");
  uploadProgressBox.classList.add("hidden");
});

async function handleFileSelection(file) {
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    showToast("Please select a valid PDF file (.pdf)");
    return;
  }

  cleanupBrowserResources();
  state.file = file;

  uploadProgressBox.classList.remove("hidden");
  uploadProgressBar.style.width = "15%";
  uploadPercentText.textContent = "15%";
  uploadStatusText.textContent = `Loading "${file.name}" (${formatBytes(file.size)})...`;

  // Check if local Python backend is reachable (only on localhost/127.0.0.1)
  const isLocalServer =
    window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";

  if (isLocalServer) {
    const uploadedViaBackend = await tryBackendUpload(file);
    if (uploadedViaBackend) {
      state.mode = "backend";
      return;
    }
  }

  // Serverless Browser Mode (GitHub Pages / Static Hosting)
  state.mode = "browser";
  await loadPdfInBrowser(file);
}

function tryBackendUpload(file) {
  return new Promise((resolve) => {
    const formData = new FormData();
    formData.append("file", file);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "./api/upload", true);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        uploadProgressBar.style.width = `${pct}%`;
        uploadPercentText.textContent = `${pct}%`;
        if (pct === 100) {
          uploadStatusText.textContent = "Inspecting PDF structure...";
        }
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          initWorkspace(data);
          resolve(true);
          return;
        } catch (_) {}
      }
      resolve(false);
    };

    xhr.onerror = () => resolve(false);
    xhr.send(formData);
  });
}

async function loadPdfInBrowser(file) {
  try {
    state.fileObjectUrl = URL.createObjectURL(file);
    const loadingTask = window.pdfjsLib.getDocument({
      url: state.fileObjectUrl,
      disableAutoFetch: true,
      disableStream: false,
    });

    loadingTask.onProgress = (p) => {
      if (p.total > 0) {
        const pct = Math.min(99, Math.round((p.loaded / p.total) * 100));
        uploadProgressBar.style.width = `${pct}%`;
        uploadPercentText.textContent = `${pct}%`;
      }
    };

    state.pdfDocProxy = await loadingTask.promise;
    uploadProgressBar.style.width = "100%";
    uploadPercentText.textContent = "100%";

    initWorkspace({
      job_id: "browser-session",
      filename: file.name,
      original_size: file.size,
      pages_count: state.pdfDocProxy.numPages,
      images_count: state.pdfDocProxy.numPages,
    });
  } catch (err) {
    showToast(`Failed to open PDF file: ${err.message || err}`);
    uploadProgressBox.classList.add("hidden");
  }
}

function initWorkspace(data) {
  state.jobId = data.job_id;
  state.filename = data.filename;
  state.originalSize = data.original_size;
  state.pagesCount = data.pages_count;
  state.imagesCount = data.images_count;
  state.currentPage = 0;
  state.hasCompressed = false;

  fileNameLabel.textContent = state.filename;
  fileNameLabel.title = state.filename;
  fileMetaLabel.textContent = `${formatBytes(state.originalSize)} • ${state.pagesCount} pages`;

  // Default unit based on file size
  if (state.originalSize < 1024 * 1024) {
    targetUnitSelect.value = "KB";
  } else {
    targetUnitSelect.value = "MB";
  }
  setTargetFromRatio(0.5);

  resultCard.classList.add("hidden");
  compPreviewImg.classList.add("hidden");
  previewPlaceholder.classList.remove("hidden");
  compressedPaneTitle.textContent = 'Compressed (click "Compress PDF")';

  uploadSection.classList.add("hidden");
  workspaceSection.classList.remove("hidden");

  updatePaginationUI();
  loadPreviews();
}

// Sizing Mode Tabs
sizingModeTabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  sizingModeTabs.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  state.sizingMode = btn.dataset.mode;

  if (state.sizingMode === "target") {
    targetSizePanel.classList.remove("hidden");
    presetQualityPanel.classList.add("hidden");
  } else {
    targetSizePanel.classList.add("hidden");
    presetQualityPanel.classList.remove("hidden");
  }
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
// In-Browser PDF Compression Engine (PDF.js + Canvas + pdf-lib)
// ============================================================================

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
    // Compute min/max luminance for fast auto-contrast
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

async function renderPageToJpegBytes(pdfDoc, pageNum1Based, dpi, quality, colorMode, bwThreshold) {
  const page = await pdfDoc.getPage(pageNum1Based);
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

async function solveBrowserTargetParams(pdfDoc, targetBytes, colorMode, bwThreshold) {
  const numPages = pdfDoc.numPages;
  const samplePages = [];
  if (numPages <= 3) {
    for (let i = 1; i <= numPages; i++) samplePages.push(i);
  } else {
    samplePages.push(1);
    samplePages.push(Math.ceil(numPages / 2));
    samplePages.push(numPages);
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
    for (const pNum of samplePages) {
      const { jpegBytes } = await renderPageToJpegBytes(
        pdfDoc,
        pNum,
        dpi,
        qual,
        colorMode,
        bwThreshold
      );
      sampleSum += jpegBytes.byteLength + 900;
    }
    const estTotal = (sampleSum / samplePages.length) * numPages + 2048;
    if (estTotal <= targetBytes * 0.93) {
      bestIdx = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return candidates[bestIdx];
}

async function compressInBrowser(payload) {
  const t0 = performance.now();
  const pdfDoc = state.pdfDocProxy;
  const numPages = pdfDoc.numPages;

  let dpiUsed = payload.dpi;
  let qualityUsed = payload.quality;

  if (payload.target_size_kb && payload.target_size_kb > 0) {
    compressBtn.innerHTML = `${ICON_SPINNER}<span>Calculating optimal parameters...</span>`;
    const targetBytes = payload.target_size_kb * 1024;
    const [optDpi, optQ] = await solveBrowserTargetParams(
      pdfDoc,
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

  for (let i = 1; i <= numPages; i++) {
    const pct = Math.round((i / numPages) * 100);
    compressBtn.innerHTML = `${ICON_SPINNER}<span>Compressing ${pct}% (${i}/${numPages})...</span>`;

    const { jpegBytes, ptWidth, ptHeight } = await renderPageToJpegBytes(
      pdfDoc,
      i,
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
    method_used: "rasterize",
    color_mode: payload.color_mode,
    dpi_used: dpiUsed,
    quality_used: qualityUsed,
    elapsed_sec: elapsedSec,
  };
}

// Compress Execution
compressBtn.addEventListener("click", async () => {
  if (!state.jobId) return;

  compressBtn.disabled = true;
  compressBtn.innerHTML = `${ICON_SPINNER}<span>Compressing PDF...</span>`;

  let targetSizeKb = null;
  if (state.sizingMode === "target") {
    const rawVal = Math.max(0.01, parseFloat(targetSizeInput.value) || 1);
    targetSizeKb = targetUnitSelect.value === "MB" ? rawVal * 1024 : rawVal;
  }

  const payload = {
    job_id: state.jobId,
    method: methodSelect.value,
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
        throw new Error(errData.detail || "Compression failed");
      }
      data = await res.json();
    } else {
      data = await compressInBrowser(payload);
    }

    state.hasCompressed = true;
    renderResultStats(data);
    await loadPreviews();
  } catch (err) {
    showToast(err.message || "Error compressing PDF");
  } finally {
    compressBtn.disabled = false;
    compressBtn.innerHTML = `${ICON_BOLT}<span>Compress PDF</span>`;
  }
});

function renderResultStats(data) {
  resultCard.classList.remove("hidden");
  origSizeStat.textContent = formatBytes(data.original_size);
  newSizeStat.textContent = formatBytes(data.compressed_size);

  const reduction = data.reduction_percent;
  if (reduction >= 0) {
    savingsBadge.textContent = `-${reduction}%`;
  } else {
    savingsBadge.textContent = `+${Math.abs(reduction)}%`;
  }

  const methodNames = {
    smart: "Smart (Selectable Text)",
    rasterize: "Optimized Stream",
  };
  const colorNames = {
    color: "Color (RGB)",
    grayscale: "Grayscale",
    bw: "Black & White",
  };

  resultDetailsText.textContent =
    `Saved: ${formatBytes(data.saved_bytes)} • ` +
    `Engine: ${methodNames[data.method_used] || data.method_used} • ` +
    `Mode: ${colorNames[data.color_mode] || data.color_mode} • ` +
    `${data.dpi_used} DPI • Quality: ${data.quality_used}% • ` +
    `Time: ${data.elapsed_sec}s`;

  const stem = state.filename.toLowerCase().endsWith(".pdf")
    ? state.filename.slice(0, -4)
    : state.filename;
  const downloadFilename = `${stem}_compressed.pdf`;
  downloadBtn.setAttribute("download", downloadFilename);

  if (state.mode === "backend") {
    downloadBtn.href = `./api/download/${state.jobId}?t=${Date.now()}`;
  } else {
    downloadBtn.href = state.compressedBlobUrl;
  }

  compressedPaneTitle.textContent = `Compressed (${formatBytes(data.compressed_size)})`;
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

async function renderProxyPageToDataUrl(pdfProxy, pageIndex0Based, dpi = 110) {
  const page = await pdfProxy.getPage(pageIndex0Based + 1);
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
    origPreviewImg.src = `./api/preview/${state.jobId}?variant=original&page=${state.currentPage}&t=${ts}`;

    if (state.hasCompressed) {
      previewPlaceholder.classList.add("hidden");
      compPreviewImg.classList.remove("hidden");
      compPreviewImg.src = `./api/preview/${state.jobId}?variant=compressed&page=${state.currentPage}&t=${ts}`;
    }
  } else {
    if (state.pdfDocProxy) {
      origPreviewImg.src = await renderProxyPageToDataUrl(state.pdfDocProxy, state.currentPage);
    }
    if (state.hasCompressed && state.compressedPdfProxy) {
      previewPlaceholder.classList.add("hidden");
      compPreviewImg.classList.remove("hidden");
      compPreviewImg.src = await renderProxyPageToDataUrl(
        state.compressedPdfProxy,
        state.currentPage
      );
    }
  }
}

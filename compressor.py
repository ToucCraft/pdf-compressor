import io
import math
import os
import tempfile
import time
from dataclasses import dataclass, asdict
from typing import Optional, Literal, Dict, Any, Tuple

import fitz  # PyMuPDF
from PIL import Image, ImageOps


ColorMode = Literal["color", "grayscale", "bw"]
CompressionMethod = Literal["smart", "rasterize", "auto"]


@dataclass
class CompressionOptions:
    method: CompressionMethod = "auto"          # "smart" (keep text), "rasterize" (page to img), "auto"
    color_mode: ColorMode = "color"             # "color", "grayscale", "bw"
    quality: int = 75                           # JPEG quality 10..95
    dpi: int = 150                              # Target DPI 36..300
    target_size_kb: Optional[float] = None      # Optional target size in KB
    bw_threshold: int = 180                     # Threshold for B&W mode (0..255)
    strip_metadata: bool = True                 # Remove metadata & XML packet
    strip_annotations: bool = False             # Remove comments/annotations
    preserve_toc: bool = True                   # Keep bookmarks / table of contents


@dataclass
class CompressionResult:
    output_path: str
    original_size: int
    compressed_size: int
    pages_count: int
    images_processed: int
    method_used: str
    quality_used: int
    dpi_used: int
    color_mode: str
    elapsed_sec: float
    target_reached: Optional[bool] = None

    def to_dict(self) -> Dict[str, Any]:
        ratio = (1.0 - (self.compressed_size / max(1, self.original_size))) * 100.0
        return {
            **asdict(self),
            "saved_bytes": max(0, self.original_size - self.compressed_size),
            "reduction_percent": round(ratio, 1),
        }


def _process_pil_image(
    img: Image.Image,
    color_mode: ColorMode,
    max_dim: Optional[int],
    quality: int,
    bw_threshold: int = 180,
) -> bytes:
    """Resize, convert color space, and compress a PIL Image to JPEG bytes."""
    # Handle transparency by compositing onto white background
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        bg = Image.new("RGB", rgba.size, (255, 255, 255))
        bg.paste(rgba, mask=rgba.split()[3])
        img = bg
    elif img.mode == "CMYK":
        img = img.convert("RGB")

    # Downscale if needed
    if max_dim and max(img.width, img.height) > max_dim:
        scale = max_dim / float(max(img.width, img.height))
        new_w = max(1, int(round(img.width * scale)))
        new_h = max(1, int(round(img.height * scale)))
        img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

    # Color space conversion
    if color_mode == "grayscale":
        img = img.convert("L")
    elif color_mode == "bw":
        gray = img.convert("L")
        gray = ImageOps.autocontrast(gray, cutoff=1)
        # Apply crisp threshold into grayscale (0 or 255) for super high JPEG compression ratio
        # or 1-bit PNG if smaller
        bw_l = gray.point(lambda x: 255 if x >= bw_threshold else 0, mode="L")
        img = bw_l
    else:
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")

    buf = io.BytesIO()
    img.save(
        buf,
        format="JPEG",
        quality=max(5, min(95, int(quality))),
        optimize=True,
        progressive=True,
    )
    return buf.getvalue()


def compress_smart(
    input_path: str,
    output_path: str,
    color_mode: ColorMode = "color",
    quality: int = 75,
    dpi: int = 150,
    bw_threshold: int = 180,
    strip_metadata: bool = True,
    strip_annotations: bool = False,
) -> int:
    """
    Smart PDF compression:
    - Preserves vector graphics, selectable text, and layout
    - Recompresses & downscales embedded images
    - Optionally converts whole document or images to grayscale / B&W
    - Cleans unused objects and compresses streams
    Returns count of processed images.
    """
    doc = fitz.open(input_path)
    processed_xrefs = set()
    images_processed = 0

    # Estimate max pixel dimension for an A4 page (~11.7 inches high) at target DPI
    max_dim = max(200, int(round(dpi * 11.7)))

    try:
        for page_index in range(len(doc)):
            page = doc[page_index]

            if strip_annotations:
                annot = page.first_annot
                while annot:
                    nxt = annot.next
                    page.delete_annot(annot)
                    annot = nxt

            img_list = page.get_images(full=True)
            for img_info in img_list:
                xref = img_info[0]
                smask = img_info[1]
                if xref in processed_xrefs:
                    continue
                processed_xrefs.add(xref)

                # Skip images that have soft masks if we want to avoid black boxes,
                # or flatten them safely
                if smask and smask > 0:
                    continue

                try:
                    base_img = doc.extract_image(xref)
                    if not base_img or "image" not in base_img:
                        continue
                    raw_bytes = base_img["image"]
                    width = base_img.get("width", 0)
                    height = base_img.get("height", 0)

                    # Skip tiny icons
                    if width < 32 and height < 32:
                        continue

                    pil_img = Image.open(io.BytesIO(raw_bytes))
                    compressed_bytes = _process_pil_image(
                        pil_img,
                        color_mode=color_mode,
                        max_dim=max_dim,
                        quality=quality,
                        bw_threshold=bw_threshold,
                    )

                    # Replace if smaller OR if user explicitly requested grayscale/bw conversion
                    if len(compressed_bytes) < len(raw_bytes) or color_mode != "color":
                        page.replace_image(xref, stream=compressed_bytes)
                        images_processed += 1
                except Exception:
                    # Skip malformed or unsupported inline image encodings gracefully
                    continue

        if strip_metadata:
            try:
                doc.set_metadata({})
                doc.del_xml_metadata()
            except Exception:
                pass

        doc.save(
            output_path,
            garbage=4,
            deflate=True,
            clean=True,
            deflate_images=True,
            deflate_fonts=True,
        )
    finally:
        doc.close()

    return images_processed


def compress_rasterize(
    input_path: str,
    output_path: str,
    color_mode: ColorMode = "color",
    quality: int = 70,
    dpi: int = 130,
    bw_threshold: int = 180,
    strip_metadata: bool = True,
    preserve_toc: bool = True,
) -> int:
    """
    Rasterize PDF compression:
    - Renders each page at `dpi`
    - Converts page to Color / Grayscale / B&W
    - Rebuilds a compact PDF with exact original page dimensions
    Returns number of rasterized pages.
    """
    src_doc = fitz.open(input_path)
    out_doc = fitz.open()
    pages_processed = 0

    try:
        toc = src_doc.get_toc() if preserve_toc else []

        for page_index in range(len(src_doc)):
            page = src_doc[page_index]
            rect = page.rect

            # Render page to pixmap
            cs = fitz.csGRAY if color_mode in ("grayscale", "bw") else fitz.csRGB
            pix = page.get_pixmap(dpi=max(36, int(dpi)), colorspace=cs, alpha=False)

            mode = "L" if pix.n == 1 else "RGB"
            pil_img = Image.frombytes(mode, (pix.width, pix.height), pix.samples)

            img_bytes = _process_pil_image(
                pil_img,
                color_mode=color_mode,
                max_dim=None,
                quality=quality,
                bw_threshold=bw_threshold,
            )

            new_page = out_doc.new_page(width=rect.width, height=rect.height)
            new_page.insert_image(rect, stream=img_bytes)
            pages_processed += 1

        if preserve_toc and toc:
            try:
                out_doc.set_toc(toc)
            except Exception:
                pass

        if not strip_metadata:
            try:
                out_doc.set_metadata(src_doc.metadata)
            except Exception:
                pass

        out_doc.save(
            output_path,
            garbage=4,
            deflate=True,
            clean=True,
        )
    finally:
        out_doc.close()
        src_doc.close()

    return pages_processed


def _estimate_raster_size_bytes(
    doc: fitz.Document,
    sample_indices: list[int],
    color_mode: ColorMode,
    dpi: int,
    quality: int,
    bw_threshold: int,
) -> int:
    """Estimate total PDF byte size by compressing a few sample pages."""
    cs = fitz.csGRAY if color_mode in ("grayscale", "bw") else fitz.csRGB
    total_sample_bytes = 0
    for idx in sample_indices:
        page = doc[idx]
        pix = page.get_pixmap(dpi=max(36, int(dpi)), colorspace=cs, alpha=False)
        mode = "L" if pix.n == 1 else "RGB"
        pil_img = Image.frombytes(mode, (pix.width, pix.height), pix.samples)
        img_bytes = _process_pil_image(
            pil_img,
            color_mode=color_mode,
            max_dim=None,
            quality=quality,
            bw_threshold=bw_threshold,
        )
        # Add ~1.2 KB per page PDF container overhead
        total_sample_bytes += len(img_bytes) + 1200

    avg_page_bytes = total_sample_bytes / max(1, len(sample_indices))
    return int(avg_page_bytes * len(doc) + 4096)


def _solve_raster_params_for_target(
    input_path: str,
    target_bytes: int,
    color_mode: ColorMode,
    bw_threshold: int,
) -> Tuple[int, int]:
    """
    Find optimal (dpi, quality) pair via fast sampling so the output PDF
    fits within `target_bytes` with the highest possible visual quality.
    """
    doc = fitz.open(input_path)
    try:
        num_pages = max(1, len(doc))
        # Pick up to 4 representative sample pages across the document
        if num_pages <= 4:
            sample_indices = list(range(num_pages))
        else:
            step = (num_pages - 1) / 3.0
            sample_indices = sorted(list({int(round(i * step)) for i in range(4)}))

        # Candidate ladder from highest quality to ultra-compact
        candidates = [
            (200, 85),
            (175, 80),
            (150, 75),
            (140, 70),
            (125, 65),
            (110, 60),
            (96, 55),
            (85, 50),
            (72, 45),
            (60, 40),
            (50, 32),
            (42, 25),
            (36, 18),
        ]

        # Binary search over the candidate ladder
        low = 0
        high = len(candidates) - 1
        best_idx = high

        while low <= high:
            mid = (low + high) // 2
            dpi, qual = candidates[mid]
            est = _estimate_raster_size_bytes(
                doc, sample_indices, color_mode, dpi, qual, bw_threshold
            )
            # Aim for 93% of target_bytes to leave a safe margin
            if est <= target_bytes * 0.93:
                best_idx = mid
                high = mid - 1  # Try higher quality (lower index)
            else:
                low = mid + 1   # Need stronger compression (higher index)

        return candidates[best_idx]
    finally:
        doc.close()


def compress_pdf(
    input_path: str,
    output_path: str,
    options: CompressionOptions,
) -> CompressionResult:
    """
    Main entry point to compress a PDF file according to `options`.
    Supports unlimited input size, color/grayscale/bw conversion,
    smart vs rasterize modes, and exact target file size in KB.
    """
    t0 = time.time()
    original_size = os.path.getsize(input_path)

    doc = fitz.open(input_path)
    pages_count = len(doc)
    doc.close()

    target_bytes = int(options.target_size_kb * 1024) if options.target_size_kb else None
    quality_used = options.quality
    dpi_used = options.dpi
    method_used = options.method
    images_processed = 0

    if target_bytes and target_bytes > 0:
        # Target size mode: try to get under target_bytes with highest quality
        ratio_needed = target_bytes / max(1, original_size)

        # 1. Try Smart mode first if method is "auto" or "smart"
        tried_smart = False
        if options.method in ("auto", "smart"):
            tried_smart = True
            # Choose smart parameters based on ratio_needed
            if ratio_needed >= 0.7:
                smart_dpi, smart_q = max(150, options.dpi), max(75, options.quality)
            elif ratio_needed >= 0.4:
                smart_dpi, smart_q = 130, 65
            elif ratio_needed >= 0.2:
                smart_dpi, smart_q = 100, 50
            else:
                smart_dpi, smart_q = 72, 35

            images_processed = compress_smart(
                input_path=input_path,
                output_path=output_path,
                color_mode=options.color_mode,
                quality=smart_q,
                dpi=smart_dpi,
                bw_threshold=options.bw_threshold,
                strip_metadata=options.strip_metadata,
                strip_annotations=options.strip_annotations,
            )
            method_used = "smart"
            quality_used = smart_q
            dpi_used = smart_dpi

            # If still above target and still in smart mode, try an aggressive smart pass
            if os.path.getsize(output_path) > target_bytes and smart_q > 25:
                images_processed = compress_smart(
                    input_path=input_path,
                    output_path=output_path,
                    color_mode=options.color_mode,
                    quality=25,
                    dpi=60,
                    bw_threshold=options.bw_threshold,
                    strip_metadata=options.strip_metadata,
                    strip_annotations=options.strip_annotations,
                )
                quality_used = 25
                dpi_used = 60

        # 2. If Smart mode didn't reach target_bytes (and method != "smart"),
        #    or if color conversion was requested on a vector-only PDF (images_processed == 0),
        #    or if method == "rasterize"
        current_size = os.path.getsize(output_path) if tried_smart and os.path.exists(output_path) else original_size + 1
        needs_color_raster = (options.method == "auto" and options.color_mode in ("grayscale", "bw") and images_processed == 0)
        if (current_size > target_bytes and options.method != "smart") or needs_color_raster or options.method == "rasterize":
            opt_dpi, opt_q = _solve_raster_params_for_target(
                input_path=input_path,
                target_bytes=target_bytes,
                color_mode=options.color_mode,
                bw_threshold=options.bw_threshold,
            )
            images_processed = compress_rasterize(
                input_path=input_path,
                output_path=output_path,
                color_mode=options.color_mode,
                quality=opt_q,
                dpi=opt_dpi,
                bw_threshold=options.bw_threshold,
                strip_metadata=options.strip_metadata,
                preserve_toc=options.preserve_toc,
            )
            method_used = "rasterize"
            quality_used = opt_q
            dpi_used = opt_dpi

            # Safety fallback if actual size slightly exceeded target_bytes
            actual_size = os.path.getsize(output_path)
            if actual_size > target_bytes and (opt_dpi > 36 or opt_q > 15):
                scale_factor = math.sqrt((target_bytes * 0.92) / max(1, actual_size))
                retry_dpi = max(36, int(opt_dpi * scale_factor))
                retry_q = max(15, int(opt_q * max(0.65, scale_factor)))
                images_processed = compress_rasterize(
                    input_path=input_path,
                    output_path=output_path,
                    color_mode=options.color_mode,
                    quality=retry_q,
                    dpi=retry_dpi,
                    bw_threshold=options.bw_threshold,
                    strip_metadata=options.strip_metadata,
                    preserve_toc=options.preserve_toc,
                )
                quality_used = retry_q
                dpi_used = retry_dpi

    else:
        # Manual / Preset mode (no strict target_size_kb)
        # Note: if user chose "grayscale" or "bw" with "auto" method, check if PDF has images;
        # if they want the whole page (including colored text/vectors) in B&W/Grayscale,
        # rasterize guarantees 100% B&W/Grayscale look when there are no images or when requested.
        if options.method == "rasterize":
            images_processed = compress_rasterize(
                input_path=input_path,
                output_path=output_path,
                color_mode=options.color_mode,
                quality=options.quality,
                dpi=options.dpi,
                bw_threshold=options.bw_threshold,
                strip_metadata=options.strip_metadata,
                preserve_toc=options.preserve_toc,
            )
            method_used = "rasterize"
        else:
            images_processed = compress_smart(
                input_path=input_path,
                output_path=output_path,
                color_mode=options.color_mode,
                quality=options.quality,
                dpi=options.dpi,
                bw_threshold=options.bw_threshold,
                strip_metadata=options.strip_metadata,
                strip_annotations=options.strip_annotations,
            )
            method_used = "smart"

            # In "auto" mode, if smart mode produced zero change on a non-color mode
            # (e.g. vector/text-only PDF that the user wants converted to B&W or Grayscale),
            # or if smart mode actually increased size on an unusual PDF:
            if options.method == "auto" and options.color_mode in ("grayscale", "bw") and images_processed == 0:
                images_processed = compress_rasterize(
                    input_path=input_path,
                    output_path=output_path,
                    color_mode=options.color_mode,
                    quality=options.quality,
                    dpi=options.dpi,
                    bw_threshold=options.bw_threshold,
                    strip_metadata=options.strip_metadata,
                    preserve_toc=options.preserve_toc,
                )
                method_used = "rasterize"

    compressed_size = os.path.getsize(output_path)
    elapsed_sec = round(time.time() - t0, 2)
    target_reached = (compressed_size <= target_bytes) if target_bytes else None

    return CompressionResult(
        output_path=output_path,
        original_size=original_size,
        compressed_size=compressed_size,
        pages_count=pages_count,
        images_processed=images_processed,
        method_used=method_used,
        quality_used=quality_used,
        dpi_used=dpi_used,
        color_mode=options.color_mode,
        elapsed_sec=elapsed_sec,
        target_reached=target_reached,
    )


def render_page_preview_png(pdf_path: str, page_number: int = 0, dpi: int = 120) -> Tuple[bytes, int]:
    """Render a single page of a PDF as PNG bytes for visual preview. Returns (png_bytes, total_pages)."""
    doc = fitz.open(pdf_path)
    try:
        total_pages = len(doc)
        idx = max(0, min(page_number, total_pages - 1))
        page = doc[idx]
        pix = page.get_pixmap(dpi=dpi, alpha=False)
        return pix.tobytes("png"), total_pages
    finally:
        doc.close()

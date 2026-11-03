import os
import re
import shutil
import zipfile
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple

import pypdf
from app.config import SESSIONS_DIR


def sanitize_filename(name: str) -> str:
    """Sanitize a string to be safe for filenames."""
    name = re.sub(r'[\\/*?:"<>|]', '_', name)
    name = re.sub(r'\s+', '_', name).strip('._')
    return name or "document"


def get_session_dir(session_id: str) -> Path:
    """Get the directory path for a session and ensure it exists."""
    s_dir = SESSIONS_DIR / session_id
    s_dir.mkdir(parents=True, exist_ok=True)
    return s_dir


def get_session_output_dir(session_id: str) -> Path:
    """Get the output directory path for a session and ensure it exists."""
    out_dir = get_session_dir(session_id) / "output"
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir


def clean_session_output(session_id: str):
    """Remove any previous output files in a session directory."""
    out_dir = get_session_dir(session_id) / "output"
    if out_dir.exists():
        shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir(parents=True, exist_ok=True)


def parse_page_ranges(range_str: str, total_pages: int) -> List[List[int]]:
    """
    Parse a range string like "1-3, 5, 7-10, 12-end" into list of page groups.
    Returns 0-based page index groups.
    E.g. "1-2, 4" -> [[0, 1], [3]]
    """
    groups: List[List[int]] = []
    if not range_str or not range_str.strip():
        return groups

    parts = [p.strip() for p in range_str.split(",") if p.strip()]
    for part in parts:
        page_group = []
        if "-" in part:
            sub = part.split("-", 1)
            start_str, end_str = sub[0].strip(), sub[1].strip().lower()
            try:
                start = int(start_str) if start_str else 1
            except ValueError:
                continue

            if end_str == "end" or end_str == "":
                end = total_pages
            else:
                try:
                    end = int(end_str)
                except ValueError:
                    continue

            # Ensure proper ordering and within bounds (1-based to 0-based)
            start = max(1, min(start, total_pages))
            end = max(1, min(end, total_pages))
            if start <= end:
                page_group = list(range(start - 1, end))
            else:
                # Reverse range if user specified e.g. 5-3
                page_group = list(range(start - 1, end - 2, -1))
        else:
            try:
                page_num = int(part)
                if 1 <= page_num <= total_pages:
                    page_group = [page_num - 1]
            except ValueError:
                continue

        if page_group:
            groups.append(page_group)

    return groups


def extract_bookmarks_tree(reader: pypdf.PdfReader) -> List[Dict[str, Any]]:
    """Extract table of contents / outlines from a PDF."""
    bookmarks = []
    try:
        def process_outline(outline_list):
            items = []
            for item in outline_list:
                if isinstance(item, list):
                    items.extend(process_outline(item))
                elif isinstance(item, pypdf.generic.Destination):
                    try:
                        page_num = reader.get_destination_page_number(item)
                        if page_num is not None:
                            items.append({
                                "title": str(item.title).strip(),
                                "page": page_num + 1,  # 1-based for human display
                                "page_index": page_num,  # 0-based
                            })
                    except Exception:
                        pass
            return items

        if reader.outline:
            bookmarks = process_outline(reader.outline)
    except Exception:
        bookmarks = []
    return bookmarks


def inspect_pdf(pdf_path: Path) -> Dict[str, Any]:
    """Inspect a PDF file and return comprehensive metadata."""
    if not pdf_path.exists():
        raise FileNotFoundError(f"PDF file not found: {pdf_path}")

    file_size = pdf_path.stat().st_size
    reader = pypdf.PdfReader(str(pdf_path))

    is_encrypted = reader.is_encrypted
    if is_encrypted:
        try:
            # Try decrypting with empty password
            reader.decrypt("")
            is_encrypted = False
        except Exception:
            is_encrypted = True

    total_pages = len(reader.pages) if not is_encrypted else 0

    # Extract metadata safely
    doc_info = {}
    if not is_encrypted and reader.metadata:
        try:
            for k, v in reader.metadata.items():
                clean_k = k.lstrip("/") if isinstance(k, str) else str(k)
                doc_info[clean_k] = str(v) if v else ""
        except Exception:
            pass

    # Extract bookmarks
    bookmarks = extract_bookmarks_tree(reader) if not is_encrypted else []

    # Get sample page dimensions (points to inches/mm/standard)
    pages_info = []
    if not is_encrypted:
        for idx, page in enumerate(reader.pages):
            try:
                mb = page.mediabox
                width = float(mb.width)
                height = float(mb.height)
                rotation = page.rotation if hasattr(page, 'rotation') else 0
                pages_info.append({
                    "page_number": idx + 1,
                    "width": round(width, 1),
                    "height": round(height, 1),
                    "rotation": rotation
                })
            except Exception:
                pages_info.append({"page_number": idx + 1, "width": 612, "height": 792, "rotation": 0})

    return {
        "filename": pdf_path.name,
        "filesize_bytes": file_size,
        "filesize_display": format_bytes(file_size),
        "total_pages": total_pages,
        "is_encrypted": is_encrypted,
        "metadata": doc_info,
        "bookmarks": bookmarks,
        "pages": pages_info,
    }


def format_bytes(num_bytes: int) -> str:
    """Format bytes into human-readable string."""
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if abs(num_bytes) < 1024.0:
            return f"{num_bytes:3.1f} {unit}"
        num_bytes /= 1024.0
    return f"{num_bytes:.1f} PB"


def package_results(session_id: str, original_filename: str, generated_files: List[Path]) -> Dict[str, Any]:
    """
    Format output files metadata, create a ZIP file if more than one file,
    and return structured result for API response.
    """
    stem = Path(original_filename).stem
    out_dir = get_session_output_dir(session_id)

    files_meta = []
    total_bytes = 0

    for fpath in generated_files:
        if fpath.exists():
            fsize = fpath.stat().st_size
            total_bytes += fsize
            # Inspect generated PDF page count
            page_count = 0
            try:
                r = pypdf.PdfReader(str(fpath))
                page_count = len(r.pages)
            except Exception:
                pass

            files_meta.append({
                "filename": fpath.name,
                "filesize_bytes": fsize,
                "filesize_display": format_bytes(fsize),
                "pages": page_count,
                "download_url": f"/api/download/{session_id}/{fpath.name}",
                "preview_url": f"/api/preview/{session_id}/{fpath.name}",
            })

    zip_meta = None
    if len(generated_files) > 1:
        zip_name = f"pdfun_{sanitize_filename(stem)}_split.zip"
        zip_path = out_dir / zip_name
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zipf:
            for fpath in generated_files:
                if fpath.exists():
                    zipf.write(fpath, arcname=fpath.name)
        zip_size = zip_path.stat().st_size
        zip_meta = {
            "filename": zip_name,
            "filesize_bytes": zip_size,
            "filesize_display": format_bytes(zip_size),
            "download_url": f"/api/download/{session_id}/{zip_name}",
        }
    elif len(generated_files) == 1:
        # Single file download is the file itself
        zip_meta = {
            "filename": generated_files[0].name,
            "filesize_bytes": files_meta[0]["filesize_bytes"],
            "filesize_display": files_meta[0]["filesize_display"],
            "download_url": files_meta[0]["download_url"],
        }

    return {
        "session_id": session_id,
        "original_filename": original_filename,
        "total_files": len(generated_files),
        "total_bytes": total_bytes,
        "total_bytes_display": format_bytes(total_bytes),
        "files": files_meta,
        "zip_package": zip_meta,
    }


def split_all_pages(session_id: str, input_path: Path) -> Dict[str, Any]:
    """Split PDF into individual single-page PDFs."""
    clean_session_output(session_id)
    out_dir = get_session_output_dir(session_id)
    stem = sanitize_filename(input_path.stem)

    reader = pypdf.PdfReader(str(input_path))
    total_pages = len(reader.pages)
    digits = max(3, len(str(total_pages)))

    generated_files = []
    for idx, page in enumerate(reader.pages):
        writer = pypdf.PdfWriter()
        writer.add_page(page)
        filename = f"{stem}_page_{idx + 1:0{digits}d}.pdf"
        dest_path = out_dir / filename
        with open(dest_path, "wb") as f_out:
            writer.write(f_out)
        generated_files.append(dest_path)

    return package_results(session_id, input_path.name, generated_files)


def split_by_ranges(
    session_id: str,
    input_path: Path,
    range_groups: List[List[int]],
    merge_ranges: bool = False,
    group_labels: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """
    Split PDF by page index groups (0-based).
    If merge_ranges is True, all selected pages are combined into one PDF.
    If merge_ranges is False, each group becomes an individual PDF.
    """
    clean_session_output(session_id)
    out_dir = get_session_output_dir(session_id)
    stem = sanitize_filename(input_path.stem)

    reader = pypdf.PdfReader(str(input_path))
    total_pages = len(reader.pages)

    generated_files = []

    if merge_ranges:
        writer = pypdf.PdfWriter()
        added_count = 0
        for group in range_groups:
            for page_idx in group:
                if 0 <= page_idx < total_pages:
                    writer.add_page(reader.pages[page_idx])
                    added_count += 1
        if added_count > 0:
            filename = f"{stem}_extracted_merged.pdf"
            dest_path = out_dir / filename
            with open(dest_path, "wb") as f_out:
                writer.write(f_out)
            generated_files.append(dest_path)
    else:
        for idx, group in enumerate(range_groups):
            if not group:
                continue
            writer = pypdf.PdfWriter()
            for page_idx in group:
                if 0 <= page_idx < total_pages:
                    writer.add_page(reader.pages[page_idx])

            if len(writer.pages) == 0:
                continue

            if group_labels and idx < len(group_labels) and group_labels[idx]:
                clean_label = sanitize_filename(group_labels[idx])
                filename = f"{stem}_{clean_label}.pdf"
            else:
                p_start = group[0] + 1
                p_end = group[-1] + 1
                if p_start == p_end:
                    filename = f"{stem}_p{p_start}.pdf"
                else:
                    filename = f"{stem}_p{p_start}-{p_end}.pdf"

            dest_path = out_dir / filename
            # Avoid filename collisions
            counter = 1
            while dest_path.exists():
                dest_path = out_dir / f"{dest_path.stem}_{counter}.pdf"
                counter += 1

            with open(dest_path, "wb") as f_out:
                writer.write(f_out)
            generated_files.append(dest_path)

    return package_results(session_id, input_path.name, generated_files)


def split_fixed_interval(session_id: str, input_path: Path, interval: int) -> Dict[str, Any]:
    """Split PDF into equal chunks of N pages each."""
    if interval < 1:
        interval = 1

    clean_session_output(session_id)
    out_dir = get_session_output_dir(session_id)
    stem = sanitize_filename(input_path.stem)

    reader = pypdf.PdfReader(str(input_path))
    total_pages = len(reader.pages)

    range_groups = []
    group_labels = []

    for start_idx in range(0, total_pages, interval):
        end_idx = min(start_idx + interval, total_pages)
        range_groups.append(list(range(start_idx, end_idx)))
        p_start = start_idx + 1
        p_end = end_idx
        group_labels.append(f"part_{len(range_groups):02d}_p{p_start}-{p_end}")

    return split_by_ranges(session_id, input_path, range_groups, merge_ranges=False, group_labels=group_labels)


def split_cut_points(session_id: str, input_path: Path, cut_points: List[int]) -> Dict[str, Any]:
    """
    Split PDF at cut points (1-based page numbers after which document cuts).
    e.g., total 10 pages, cut_points = [3, 7]
    Produces Part 1 (1..3), Part 2 (4..7), Part 3 (8..10).
    """
    clean_session_output(session_id)
    reader = pypdf.PdfReader(str(input_path))
    total_pages = len(reader.pages)

    # Filter and sort cut points
    valid_cuts = sorted(list(set(c for c in cut_points if 1 <= c < total_pages)))

    range_groups = []
    group_labels = []
    current_start = 0

    for idx, cut in enumerate(valid_cuts):
        # cut is 1-based, so slice is current_start to cut
        group = list(range(current_start, cut))
        if group:
            range_groups.append(group)
            group_labels.append(f"section_{idx + 1:02d}_p{current_start + 1}-{cut}")
        current_start = cut

    # Final section
    if current_start < total_pages:
        group = list(range(current_start, total_pages))
        range_groups.append(group)
        group_labels.append(f"section_{len(range_groups):02d}_p{current_start + 1}-{total_pages}")

    return split_by_ranges(session_id, input_path, range_groups, merge_ranges=False, group_labels=group_labels)


def split_even_odd(session_id: str, input_path: Path) -> Dict[str, Any]:
    """Split PDF into Even and Odd page sets."""
    clean_session_output(session_id)
    out_dir = get_session_output_dir(session_id)
    stem = sanitize_filename(input_path.stem)

    reader = pypdf.PdfReader(str(input_path))
    total_pages = len(reader.pages)

    odd_writer = pypdf.PdfWriter()
    even_writer = pypdf.PdfWriter()

    for idx in range(total_pages):
        page_num = idx + 1
        if page_num % 2 == 1:
            odd_writer.add_page(reader.pages[idx])
        else:
            even_writer.add_page(reader.pages[idx])

    generated_files = []

    if len(odd_writer.pages) > 0:
        odd_file = out_dir / f"{stem}_odd_pages.pdf"
        with open(odd_file, "wb") as f:
            odd_writer.write(f)
        generated_files.append(odd_file)

    if len(even_writer.pages) > 0:
        even_file = out_dir / f"{stem}_even_pages.pdf"
        with open(even_file, "wb") as f:
            even_writer.write(f)
        generated_files.append(even_file)

    return package_results(session_id, input_path.name, generated_files)


def split_by_bookmarks(session_id: str, input_path: Path) -> Dict[str, Any]:
    """Split PDF at chapter/bookmark boundaries."""
    clean_session_output(session_id)
    reader = pypdf.PdfReader(str(input_path))
    total_pages = len(reader.pages)
    bookmarks = extract_bookmarks_tree(reader)

    if not bookmarks:
        raise ValueError("This PDF does not contain any table of contents / bookmarks to split by.")

    # Deduplicate bookmarks by start page and sort
    sorted_bm = sorted(bookmarks, key=lambda x: x["page_index"])
    unique_cuts = []
    seen_pages = set()
    for bm in sorted_bm:
        p = bm["page_index"]
        if p not in seen_pages and 0 <= p < total_pages:
            seen_pages.add(p)
            unique_cuts.append(bm)

    if not unique_cuts:
        raise ValueError("No valid bookmark start pages found.")

    range_groups = []
    group_labels = []

    for i, bm in enumerate(unique_cuts):
        start_p = bm["page_index"]
        end_p = unique_cuts[i + 1]["page_index"] if i + 1 < len(unique_cuts) else total_pages
        if start_p < end_p:
            range_groups.append(list(range(start_p, end_p)))
            clean_title = sanitize_filename(bm["title"])[:40]
            group_labels.append(f"{i + 1:02d}_{clean_title}")

    return split_by_ranges(session_id, input_path, range_groups, merge_ranges=False, group_labels=group_labels)


def merge_pdf_files(session_id: str, file_paths: List[Path], output_filename: str = "pdfun_merged.pdf") -> Dict[str, Any]:
    """Merge multiple PDF files into one output PDF."""
    clean_session_output(session_id)
    out_dir = get_session_output_dir(session_id)

    writer = pypdf.PdfWriter()
    for fpath in file_paths:
        if fpath.exists():
            reader = pypdf.PdfReader(str(fpath))
            for page in reader.pages:
                writer.add_page(page)

    safe_name = sanitize_filename(Path(output_filename).stem) + ".pdf"
    dest_path = out_dir / safe_name
    with open(dest_path, "wb") as f_out:
        writer.write(f_out)

    return package_results(session_id, output_filename, [dest_path])


def rotate_pdf_pages(
    session_id: str,
    input_path: Path,
    angle: int = 90,
    page_numbers: Optional[List[int]] = None,
) -> Dict[str, Any]:
    """
    Rotate PDF pages (90, 180, 270 degrees clockwise).
    If page_numbers is None or empty, rotates all pages.
    page_numbers is 1-based.
    """
    clean_session_output(session_id)
    out_dir = get_session_output_dir(session_id)
    stem = sanitize_filename(input_path.stem)

    reader = pypdf.PdfReader(str(input_path))
    writer = pypdf.PdfWriter()

    selected_set = set(page_numbers) if page_numbers else None

    for idx, page in enumerate(reader.pages):
        page_num = idx + 1
        if selected_set is None or page_num in selected_set:
            page.rotate(angle)
        writer.add_page(page)

    dest_path = out_dir / f"{stem}_rotated_{angle}deg.pdf"
    with open(dest_path, "wb") as f_out:
        writer.write(f_out)

    return package_results(session_id, input_path.name, [dest_path])

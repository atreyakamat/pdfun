# pdfun ✂️📑

> **Fast, private, and unlimited PDF toolkit with a browser UI & Python backend.**  
> Split, merge, rotate, and transform PDFs of any size with zero artificial limits.

---

## 🌟 Highlights

- **Hero Feature — Comprehensive PDF Splitting**:
  - **✂️ Visual Cut Points**: View interactive page thumbnails rendered in your browser and click scissor dividers between pages to cut documents with precision.
  - **🔢 Custom Page Ranges**: Expression support such as `1-3, 5, 7-10, 12-end`, with one-click presets (First Half, Second Half, Odd, Even).
  - **✅ Selected Pages**: Check/uncheck specific pages to extract (merge or keep separate).
  - **📏 Fixed Intervals**: Split every $N$ pages (e.g., every 1 page, 2 pages, 5 pages).
  - **📄 Extract All Pages**: Every page exported as an individual PDF.
  - **⚖️ Even & Odd Pages**: Perfect for scanning workflows (creates odd pages doc & even pages doc).
  - **📖 Table of Contents / Bookmarks**: Automatically detects chapters/outlines and splits along section boundaries using chapter titles.
- **⚡ No Storage or File Size Limits**:
  - Streaming chunk direct-to-disk architecture (1MB chunks) via asynchronous I/O.
  - Memory-safe: RAM usage stays low whether your PDF is 10 MB or 10 GB.
  - No artificial `MAX_CONTENT_LENGTH` or body size limits.
  - Automated 2-hour TTL disk cleanup daemon + instant manual session wipe button.
- **🎨 Normal HTML, CSS, JS Frontend**:
  - Pure vanilla frontend: no React, Vue, Webpack, or npm build step.
  - Bundled local **PDF.js** engine (works 100% offline).
  - Dark / Light mode toggle (persists in `localStorage`).
  - Real-time upload progress bar and friendly toast notifications.
  - Instant ZIP package downloads for multi-file splits.
- **📑 Bonus PDF Tools**:
  - **Merge PDFs**: Upload multiple documents, reorder via up/down controls, and merge into one.
  - **Rotate Pages**: Rotate all or selected pages (90° CW, 180°, 90° CCW).

---

## 🚀 Quickstart

### 1. Requirements
- Python 3.10+ (Tested on Python 3.12)
- Dependencies in `requirements.txt`

### 2. Setup & Installation
```bash
# Clone or navigate to the directory
cd /home/atreya/Work/pdf-split

# Install Python dependencies
pip install -r requirements.txt
```

### 3. Run the Application
You can run using the included script:
```bash
./run.sh
```
Or directly with Uvicorn:
```bash
python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8080 --reload
```

Open your browser to:
👉 **[http://127.0.0.1:8080](http://127.0.0.1:8080)**

---

## 🏗️ Project Structure

```
pdf-split/
├── app/
│   ├── __init__.py
│   ├── config.py              # Configuration & storage settings
│   ├── cleanup.py             # Disk stats & background session cleanup daemon
│   ├── main.py                # FastAPI backend & streaming REST endpoints
│   ├── pdf_service.py         # Pure Python PDF engine (pypdf)
│   ├── static/
│   │   ├── css/
│   │   │   └── style.css      # Vanilla CSS3 with Dark/Light mode & responsive layout
│   │   ├── js/
│   │   │   ├── app.js         # Vanilla JS application controller & PDF.js viewer
│   │   │   └── vendor/
│   │   │       ├── pdf.min.js # Bundled offline PDF.js viewer
│   │   │       └── pdf.worker.min.js
│   │   └── favicon.svg        # Custom vector logo
│   └── templates/
│       └── index.html         # Vanilla semantic HTML5 user interface
├── data/
│   └── sessions/              # Ephemeral session storage (auto-purged)
├── tests/
│   ├── test_pdf_service.py    # Unit tests for splitting & transformations
│   └── test_api_endpoints.py  # End-to-end API integration tests
├── requirements.txt           # Python dependencies
├── run.sh                     # Launch script
└── README.md
```

---

## 📡 REST API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Web application UI |
| `GET` | `/api/system-info` | Real-time disk capacity, active sessions, and limit info |
| `POST` | `/api/upload` | Stream PDF upload directly to disk (returns metadata & session ID) |
| `POST` | `/api/split` | Perform split (`all`, `ranges`, `interval`, `cut_points`, `selected`, `even_odd`, `bookmarks`) |
| `POST` | `/api/merge` | Merge multiple uploaded PDF files |
| `POST` | `/api/rotate` | Rotate pages by 90°, 180°, or 270° |
| `GET` | `/api/download/{session_id}/{file}` | Download output PDF or ZIP archive |
| `GET` | `/api/preview/{session_id}/{file}` | Inline PDF preview in browser |
| `DELETE` | `/api/session/{session_id}` | Manually wipe session files from disk |

Interactive Swagger / OpenAPI docs are available at **`/docs`**.

---

## 🧪 Testing

Run all unit and integration tests:
```bash
python3 -m unittest discover tests
```
All 13 tests verify PDF operations, range slicing, bookmark extraction, streaming upload, ZIP bundling, rotation, merging, and API routes.

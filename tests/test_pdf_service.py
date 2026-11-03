import unittest
import tempfile
import shutil
from pathlib import Path
import pypdf

from app.pdf_service import (
    parse_page_ranges,
    sanitize_filename,
    split_all_pages,
    split_by_ranges,
    split_fixed_interval,
    split_cut_points,
    split_even_odd,
    split_by_bookmarks,
    merge_pdf_files,
    rotate_pdf_pages,
    inspect_pdf,
    get_session_dir,
)
from app.config import SESSIONS_DIR


class TestPdfService(unittest.TestCase):
    def setUp(self):
        self.session_id = "test_session_unit_123"
        self.session_dir = get_session_dir(self.session_id)
        
        # Create a dummy 6-page test PDF with bookmarks
        self.test_pdf = self.session_dir / "sample_doc.pdf"
        writer = pypdf.PdfWriter()
        for i in range(6):
            writer.add_blank_page(width=300, height=400)
        writer.add_outline_item("Chapter 1", 0)
        writer.add_outline_item("Chapter 2", 2)
        writer.add_outline_item("Chapter 3", 4)
        with open(self.test_pdf, "wb") as f:
            writer.write(f)

    def tearDown(self):
        # Clean up test session
        shutil.rmtree(self.session_dir, ignore_errors=True)

    def test_range_parsing(self):
        # 1-based human ranges to 0-based index groups
        groups = parse_page_ranges("1-2, 4, 6", 6)
        self.assertEqual(groups, [[0, 1], [3], [5]])

        # "end" keyword
        groups2 = parse_page_ranges("3-end", 6)
        self.assertEqual(groups2, [[2, 3, 4, 5]])

        # Invalid / out of bounds
        groups3 = parse_page_ranges("10-20, abc, 2", 6)
        self.assertEqual(groups3, [[5], [1]])

    def test_inspect_pdf(self):
        info = inspect_pdf(self.test_pdf)
        self.assertEqual(info["total_pages"], 6)
        self.assertFalse(info["is_encrypted"])
        self.assertEqual(len(info["bookmarks"]), 3)
        self.assertEqual(info["bookmarks"][0]["title"], "Chapter 1")

    def test_split_all_pages(self):
        result = split_all_pages(self.session_id, self.test_pdf)
        self.assertEqual(result["total_files"], 6)
        self.assertIsNotNone(result["zip_package"])
        self.assertTrue(result["zip_package"]["filename"].endswith(".zip"))

    def test_split_by_ranges(self):
        # Test separate parts
        groups = [[0, 1], [2, 3], [4, 5]]
        result = split_by_ranges(self.session_id, self.test_pdf, groups, merge_ranges=False)
        self.assertEqual(result["total_files"], 3)

        # Test merged
        result_merged = split_by_ranges(self.session_id, self.test_pdf, groups, merge_ranges=True)
        self.assertEqual(result_merged["total_files"], 1)

    def test_split_fixed_interval(self):
        # 6 pages with interval of 2 => 3 parts
        result = split_fixed_interval(self.session_id, self.test_pdf, interval=2)
        self.assertEqual(result["total_files"], 3)

    def test_split_cut_points(self):
        # Cut after page 2 and page 5 => [1..2], [3..5], [6]
        result = split_cut_points(self.session_id, self.test_pdf, cut_points=[2, 5])
        self.assertEqual(result["total_files"], 3)

    def test_split_even_odd(self):
        result = split_even_odd(self.session_id, self.test_pdf)
        self.assertEqual(result["total_files"], 2)

    def test_split_by_bookmarks(self):
        result = split_by_bookmarks(self.session_id, self.test_pdf)
        # Chapters start at page index 0, 2, 4 -> 3 files: (0..1), (2..3), (4..5)
        self.assertEqual(result["total_files"], 3)

    def test_rotate_pdf(self):
        result = rotate_pdf_pages(self.session_id, self.test_pdf, angle=90, page_numbers=[1, 3])
        self.assertEqual(result["total_files"], 1)
        r = pypdf.PdfReader(str(self.session_dir / "output" / result["files"][0]["filename"]))
        self.assertEqual(r.pages[0].rotation, 90)
        self.assertEqual(r.pages[1].rotation, 0)
        self.assertEqual(r.pages[2].rotation, 90)


if __name__ == "__main__":
    unittest.main()

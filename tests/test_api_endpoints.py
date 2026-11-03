import io
import unittest
from fastapi.testclient import TestClient
import pypdf

from app.main import app


class TestPdfApiEndpoints(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        
        # Helper to generate a multi-page PDF in bytes
        writer = pypdf.PdfWriter()
        for i in range(5):
            writer.add_blank_page(width=200, height=300)
        writer.add_outline_item("Chapter 1", 0)
        writer.add_outline_item("Chapter 2", 2)
        buf = io.BytesIO()
        writer.write(buf)
        buf.seek(0)
        self.sample_pdf_bytes = buf.getvalue()

    def test_serve_index(self):
        res = self.client.get("/")
        self.assertEqual(res.status_code, 200)
        self.assertIn("pdfun", res.text)
        self.assertIn("Split Any PDF Without Limits", res.text)

    def test_system_info(self):
        res = self.client.get("/api/system-info")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["app"], "pdfun")
        self.assertTrue(data["storage"]["unlimited"])
        self.assertIn("free_gb", data["storage"])

    def test_upload_and_split_workflow(self):
        # 1. Upload PDF
        upload_res = self.client.post(
            "/api/upload",
            files={"file": ("test_doc.pdf", self.sample_pdf_bytes, "application/pdf")},
        )
        self.assertEqual(upload_res.status_code, 200)
        upload_data = upload_res.json()
        self.assertTrue(upload_data["success"])
        session_id = upload_data["session_id"]
        filename = upload_data["filename"]
        self.assertEqual(upload_data["info"]["total_pages"], 5)

        # 2. Split with "all" mode
        split_res = self.client.post(
            "/api/split",
            json={
                "session_id": session_id,
                "filename": filename,
                "mode": "all",
            },
        )
        self.assertEqual(split_res.status_code, 200)
        split_data = split_res.json()["data"]
        self.assertEqual(split_data["total_files"], 5)
        self.assertIsNotNone(split_data["zip_package"])

        # 3. Test downloading the zip package
        zip_filename = split_data["zip_package"]["filename"]
        dl_res = self.client.get(f"/api/download/{session_id}/{zip_filename}")
        self.assertEqual(dl_res.status_code, 200)
        self.assertEqual(dl_res.headers["content-type"], "application/zip")

        # 4. Split with "ranges" mode
        ranges_res = self.client.post(
            "/api/split",
            json={
                "session_id": session_id,
                "filename": filename,
                "mode": "ranges",
                "ranges_str": "1-2, 3-5",
                "merge_ranges": False,
            },
        )
        self.assertEqual(ranges_res.status_code, 200)
        ranges_data = ranges_res.json()["data"]
        self.assertEqual(ranges_data["total_files"], 2)

        # 5. Split with "cut_points" mode (e.g. cut after page 2)
        cut_res = self.client.post(
            "/api/split",
            json={
                "session_id": session_id,
                "filename": filename,
                "mode": "cut_points",
                "cut_points": [2],
            },
        )
        self.assertEqual(cut_res.status_code, 200)
        cut_data = cut_res.json()["data"]
        self.assertEqual(cut_data["total_files"], 2)

        # 6. Test Rotate
        rotate_res = self.client.post(
            "/api/rotate",
            json={
                "session_id": session_id,
                "filename": filename,
                "angle": 180,
            },
        )
        self.assertEqual(rotate_res.status_code, 200)
        rotate_data = rotate_res.json()["data"]
        self.assertEqual(rotate_data["total_files"], 1)

        # 7. Clean up session
        del_res = self.client.delete(f"/api/session/{session_id}")
        self.assertEqual(del_res.status_code, 200)
        self.assertTrue(del_res.json()["success"])

    def test_merge_endpoint(self):
        res = self.client.post(
            "/api/merge",
            files=[
                ("files", ("part1.pdf", self.sample_pdf_bytes, "application/pdf")),
                ("files", ("part2.pdf", self.sample_pdf_bytes, "application/pdf")),
            ],
        )
        self.assertEqual(res.status_code, 200)
        data = res.json()["data"]
        self.assertEqual(data["total_files"], 1)
        self.assertEqual(data["files"][0]["pages"], 10)  # 5 + 5 = 10 pages


if __name__ == "__main__":
    unittest.main()

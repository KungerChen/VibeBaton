"""Tests for the ledger's monthly HTML page and its HTTP server."""

from datetime import date
from urllib.error import HTTPError
from urllib.request import urlopen

from ledger import web
from ledger.db import add_record
from ledger.tests.helpers import ServerThread, TempDbTestCase, make_record


class TestRenderPage(TempDbTestCase):
    def test_renders_monthly_totals_and_records(self) -> None:
        food_id = add_record(
            self.conn,
            make_record(
                amount_cents=1234, category="Food", date="2026-11-15", note="Lunch"
            ),
        )
        rent_id = add_record(
            self.conn,
            make_record(
                amount_cents=5000, category="Rent", date="2026-11-01", note="Lease"
            ),
        )
        salary_id = add_record(
            self.conn,
            make_record(
                kind="income",
                amount_cents=100000,
                category="Salary",
                date="2026-11-15",
                note="Payday",
            ),
        )

        page = web.render_page(self.conn, "2026-11")

        self.assertTrue(page.startswith("<!DOCTYPE html>"))
        self.assertIn('<meta charset="utf-8">', page)
        self.assertIn("<h1>2026-11</h1>", page)
        self.assertIn("<tr><td>Rent</td><td>50.00</td><td>1</td></tr>", page)
        self.assertIn("<tr><td>Food</td><td>12.34</td><td>1</td></tr>", page)
        self.assertIn("<tr><td>合计</td><td>62.34</td><td>2</td></tr>", page)

        summary = page[
            page.index('<table id="summary">') : page.index('<table id="records">')
        ]
        self.assertLess(summary.index("Rent"), summary.index("Food"))
        self.assertNotIn("Salary", summary)

        self.assertIn(
            f"<tr><td>{rent_id}</td><td>2026-11-01</td><td>expense</td>"
            "<td>Rent</td><td>50.00</td><td>Lease</td></tr>",
            page,
        )
        self.assertIn(
            f"<tr><td>{food_id}</td><td>2026-11-15</td><td>expense</td>"
            "<td>Food</td><td>12.34</td><td>Lunch</td></tr>",
            page,
        )
        self.assertIn(
            f"<tr><td>{salary_id}</td><td>2026-11-15</td><td>income</td>"
            "<td>Salary</td><td>1000.00</td><td>Payday</td></tr>",
            page,
        )

    def test_excludes_records_from_other_months(self) -> None:
        add_record(self.conn, make_record(date="2026-11-15", note="November"))
        add_record(self.conn, make_record(date="2026-10-31", note="October"))

        page = web.render_page(self.conn, "2026-11")

        self.assertIn("November", page)
        self.assertNotIn("October", page)
        self.assertNotIn("2026-10", page)

    def test_escapes_user_provided_text(self) -> None:
        add_record(
            self.conn,
            make_record(
                category='Food & "Drink"',
                note='<script>alert("lunch")</script>',
            ),
        )

        page = web.render_page(self.conn, "2026-11")

        self.assertIn("&lt;script&gt;alert(&quot;lunch&quot;)&lt;/script&gt;", page)
        self.assertNotIn("<script>", page)
        self.assertIn("Food &amp; &quot;Drink&quot;", page)
        self.assertNotIn('Food & "Drink"', page)

    def test_renders_an_empty_month(self) -> None:
        add_record(self.conn, make_record(date="2026-11-15", note="November"))

        page = web.render_page(self.conn, "2026-09")

        self.assertIn("<h1>2026-09</h1>", page)
        self.assertIn("<tr><td>合计</td><td>0.00</td><td>0</td></tr>", page)
        self.assertNotIn("November", page)
        self.assertNotIn("<td>expense</td>", page)

    def test_rejects_an_invalid_month(self) -> None:
        for text in ("2026-00", "2026-13", "2026-1", "202611", "", "0000-01"):
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    web.render_page(self.conn, text)


class ServerTestCase(TempDbTestCase):
    """Give each test a running server that stops before database cleanup."""

    def setUp(self) -> None:
        super().setUp()
        self.server = ServerThread(self.db_path)

    def tearDown(self) -> None:
        try:
            self.server.stop()
        finally:
            super().tearDown()

    def get(self, path: str) -> tuple[int, str, str]:
        """Request a path, returning the status, content type, and body."""
        try:
            response = urlopen(f"{self.server.base_url}{path}", timeout=5)
            status = response.status
        except HTTPError as error:
            response = error
            status = error.code
        try:
            return (
                status,
                response.headers["Content-Type"],
                response.read().decode("utf-8"),
            )
        finally:
            response.close()


class TestServer(ServerTestCase):
    def test_root_serves_the_current_month(self) -> None:
        month = date.today().strftime("%Y-%m")
        add_record(self.conn, make_record(date=f"{month}-15", note="This month"))

        status, content_type, page = self.get("/")

        self.assertEqual(status, 200)
        self.assertEqual(content_type, "text/html; charset=utf-8")
        self.assertIn(f"<h1>{month}</h1>", page)
        self.assertIn("This month", page)

    def test_month_parameter_selects_the_month(self) -> None:
        october_id = add_record(
            self.conn, make_record(date="2026-10-31", note="October")
        )
        add_record(self.conn, make_record(date="2026-11-15", note="November"))

        status, content_type, page = self.get("/?month=2026-10")

        self.assertEqual(status, 200)
        self.assertEqual(content_type, "text/html; charset=utf-8")
        self.assertIn("<h1>2026-10</h1>", page)
        self.assertIn(f"<tr><td>{october_id}</td><td>2026-10-31</td>", page)
        self.assertIn("October", page)
        self.assertNotIn("November", page)

    def test_invalid_month_returns_400(self) -> None:
        for query in ("?month=2026-13", "?month=", "?month=2026-1"):
            with self.subTest(query=query):
                status, content_type, _ = self.get(f"/{query}")

                self.assertEqual(status, 400)
                self.assertEqual(content_type, "text/html; charset=utf-8")

    def test_unknown_path_returns_404(self) -> None:
        for path in ("/missing", "/index.html", "/;missing"):
            with self.subTest(path=path):
                status, content_type, _ = self.get(path)

                self.assertEqual(status, 404)
                self.assertEqual(content_type, "text/html; charset=utf-8")

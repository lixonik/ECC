import dataclasses
import hashlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

BRIDGE = Path(__file__).parents[1] / "skills" / "ub-mode" / "scripts" / "analyze.py"
SPEC = importlib.util.spec_from_file_location("ub_mode_analysis", BRIDGE)
analysis = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(analysis)


@dataclasses.dataclass
class Score:
    name: str
    namespace: str
    complexity: int
    coverage: float
    crap: float
    path: str
    language: str


@dataclasses.dataclass
class Span:
    file: str
    start_line: int = 1
    end_line: int = 1


@dataclasses.dataclass
class Duplicate:
    score: float
    language: str
    left: Span
    right: Span
    left_nodes: int = 30
    right_nodes: int = 30


@dataclasses.dataclass
class Site:
    file: str
    namespace: str
    form_id: str
    name: str
    line: int
    start: int
    end: int
    original: str
    mutant: str
    category: str
    mutation_id: str
    anchor_line: int = 1


class FakeTools:
    def __init__(self):
        self.scores = {}
        self.coverage = {}
        self.duplicates = []
        self.dryer_inputs = []
        self.warnings = []

    def load(self, tool):
        shared = {"version": "0.1.0", "language_of": self.language_of}
        if tool == "crapper":
            return SimpleNamespace(
                **shared,
                load_bundle=lambda _root: SimpleNamespace(percent_for=self.percent_for),
                analyze_files=self.analyze_files,
                functions_in_file=self.functions_in_file,
            )
        if tool == "dryer":
            return SimpleNamespace(
                **shared,
                scan_files=self.scan_files,
                find_duplicates=lambda _entries, _threshold: self.duplicates,
            )
        return SimpleNamespace(
            **shared,
            sites_in_file=self.sites_in_file,
            covered_lines=lambda _root, path, _language: self.coverage.get(
                path.name, {1}
            ),
        )

    @staticmethod
    def language_of(path):
        return "typescript" if path.suffix in {".ts", ".js"} else None

    def percent_for(self, function):
        return (
            100.0
            if self.coverage.get(Path(function.path).name, {1}) is not None
            else None
        )

    def analyze_files(self, files, root, _bundle):
        return [
            Score(
                "check",
                path.stem,
                3,
                100.0,
                self.scores.get(path.name, 3),
                path.relative_to(root).as_posix(),
                "typescript",
            )
            for path in files
        ]

    @staticmethod
    def functions_in_file(_language, _source, relative, _root):
        return [
            SimpleNamespace(
                name="check",
                namespace=Path(relative).stem,
                path=relative,
                start_line=1,
                end_line=1,
            )
        ]

    def scan_files(self, files, _root, min_lines, min_nodes):
        self.dryer_inputs = files
        if min_lines != 4 or min_nodes != 20:
            raise AssertionError("Unexpected duplication bounds")
        return [], self.warnings

    @staticmethod
    def sites_in_file(source, _path, _root, relative):
        start = source.encode("utf-8").index(b">")
        return [
            Site(
                relative,
                "source",
                "defn/check",
                "check",
                1,
                start,
                start + 1,
                ">",
                ">=",
                "comparison",
                relative,
            )
        ]


class AnalysisTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="ecc-ub-analysis-")
        self.root = Path(self.directory.name)
        (self.root / "src").mkdir()
        self.source = "export function check(value: number) { return value > 0; }\n"
        for name in ["changed.ts", "baseline.ts", "other.ts"]:
            (self.root / "src" / name).write_text(self.source, encoding="utf-8")
        self.request = {"project": str(self.root), "files": ["src/changed.ts"]}
        self.tools = FakeTools()

    def tearDown(self):
        self.directory.cleanup()

    def run_analysis(self):
        return analysis.analyze(self.request, loader=self.tools.load)

    def test_review_reports_real_tool_contracts_without_writing_project_files(self):
        before = {
            path.relative_to(self.root): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file()
        }
        report = self.run_analysis()
        self.assertEqual(report["schemaVersion"], 1)
        self.assertEqual(report["tools"]["crapper"]["status"], "pass")
        self.assertEqual(report["tools"]["dryer"]["status"], "pass")
        mutation = report["tools"]["mutator"]
        self.assertEqual(mutation["status"], "inventory")
        self.assertEqual(mutation["mode"], "scan")
        self.assertTrue(mutation["sites"][0]["covered"])
        self.assertEqual(
            mutation["sites"][0]["sourceSha256"],
            hashlib.sha256((self.root / "src/changed.ts").read_bytes()).hexdigest(),
        )
        after = {
            path.relative_to(self.root): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file()
        }
        self.assertEqual(before, after)

    def test_crap_score_exactly_ten_is_a_finding_with_source_location(self):
        self.tools.scores["changed.ts"] = 10
        crapper = self.run_analysis()["tools"]["crapper"]
        self.assertEqual(crapper["status"], "fail")
        self.assertEqual(crapper["findings"][0]["path"], "src/changed.ts")
        self.assertEqual(crapper["findings"][0]["line"], 1)
        self.assertEqual(crapper["findings"][0]["crap"], 10)

    def test_missing_coverage_cannot_appear_as_a_clean_quality_gate(self):
        self.tools.coverage["changed.ts"] = None
        report = self.run_analysis()["tools"]
        self.assertEqual(report["crapper"]["status"], "incomplete")
        self.assertEqual(report["crapper"]["coverageMissing"], ["src/changed.ts"])
        self.assertIsNone(report["mutator"]["sites"][0]["covered"])

    def test_duplication_compares_unchanged_sources_and_filters_unrelated_pairs(self):
        self.tools.duplicates = [
            Duplicate(
                0.9, "typescript", Span("src/changed.ts"), Span("src/baseline.ts")
            ),
            Duplicate(
                0.95, "typescript", Span("src/baseline.ts"), Span("src/other.ts")
            ),
        ]
        dryer = self.run_analysis()["tools"]["dryer"]
        self.assertEqual(len(self.tools.dryer_inputs), 3)
        self.assertEqual(dryer["status"], "fail")
        self.assertEqual(len(dryer["duplicates"]), 1)
        self.assertEqual(dryer["duplicates"][0]["right"]["file"], "src/baseline.ts")

    def test_javascript_is_explicitly_unsupported_by_this_dryer_snapshot(self):
        (self.root / "src" / "changed.js").write_text(self.source, encoding="utf-8")
        self.request["files"] = ["src/changed.js"]
        dryer = self.run_analysis()["tools"]["dryer"]
        self.assertEqual(dryer["status"], "not-applicable")
        self.assertEqual(dryer["unsupportedFiles"], ["src/changed.js"])

    def test_uncovered_sites_are_distinguished_from_unknown_coverage(self):
        self.tools.coverage["changed.ts"] = set()
        mutation = self.run_analysis()["tools"]["mutator"]
        self.assertFalse(mutation["sites"][0]["covered"])
        self.assertEqual(mutation["uncovered"], 1)

    def test_mixed_supported_and_unsupported_changes_do_not_pass_duplication(self):
        (self.root / "src" / "changed.js").write_text(self.source, encoding="utf-8")
        self.request["files"].append("src/changed.js")
        dryer = self.run_analysis()["tools"]["dryer"]
        self.assertEqual(dryer["status"], "incomplete")
        self.assertEqual(dryer["unsupportedFiles"], ["src/changed.js"])

    def test_non_python_source_names_starting_with_test_are_analyzed(self):
        (self.root / "src" / "test_utility.ts").write_text(
            self.source, encoding="utf-8"
        )
        self.request["files"] = ["src/test_utility.ts"]
        report = self.run_analysis()["tools"]
        self.assertEqual(report["crapper"]["status"], "pass")
        self.assertEqual(len(report["mutator"]["sites"]), 1)

    def test_source_changes_during_analysis_invalidate_the_report(self):
        original_scan = self.tools.scan_files

        def changing_scan(*args, **kwargs):
            result = original_scan(*args, **kwargs)
            (self.root / "src" / "baseline.ts").write_text(
                "Changed during analysis", encoding="utf-8"
            )
            return result

        self.tools.scan_files = changing_scan
        with self.assertRaises(analysis.InvalidRequestError):
            self.run_analysis()

    def test_unknown_duplication_parse_warnings_cannot_pass(self):
        self.tools.warnings = ["A form could not be parsed"]
        self.assertEqual(self.run_analysis()["tools"]["dryer"]["status"], "incomplete")

    def test_non_source_changes_need_no_optional_tool_import(self):
        (self.root / "README.md").write_text("Documentation", encoding="utf-8")
        self.request["files"] = ["README.md"]
        loader = mock.Mock(side_effect=AssertionError("No tool should load"))
        report = analysis.analyze(self.request, loader=loader)
        self.assertTrue(
            all(tool["status"] == "not-applicable" for tool in report["tools"].values())
        )
        loader.assert_not_called()

    def test_missing_dependencies_and_internal_errors_are_redacted(self):
        for error, status in [
            (ImportError("private-token"), "unavailable"),
            (RuntimeError("private-token"), "error"),
        ]:
            report = analysis.analyze(self.request, loader=mock.Mock(side_effect=error))
            self.assertTrue(
                all(tool["status"] == status for tool in report["tools"].values())
            )
            self.assertNotIn("private-token", json.dumps(report))

    def test_project_and_file_paths_must_stay_inside_the_project(self):
        invalid = [
            {},
            {"project": "\0", "files": []},
            {"project": ".", "files": ["src/changed.ts"]},
            {"project": str(self.root), "files": ["../outside.ts"]},
            {"project": str(self.root), "files": [str(self.root / "src/changed.ts")]},
            {"project": str(self.root), "files": ["C:outside.ts"]},
            {"project": str(self.root), "files": ["src/missing.ts"]},
            {"project": str(self.root), "files": "src/changed.ts"},
            {"project": str(self.root), "files": [""]},
            {"project": str(self.root), "files": ["src"]},
        ]
        for request in invalid:
            with (
                self.subTest(request=request),
                self.assertRaises(analysis.InvalidRequestError),
            ):
                analysis.analyze(request, loader=self.tools.load)

    def test_symlink_sources_are_rejected(self):
        linked = self.root / "src" / "linked.ts"
        try:
            linked.symlink_to(self.root / "src" / "changed.ts")
        except OSError:
            self.skipTest("Symbolic links are unavailable")
        self.request["files"] = ["src/linked.ts"]
        with self.assertRaises(analysis.InvalidRequestError):
            self.run_analysis()

    def test_source_byte_and_file_count_limits_fail_closed(self):
        with (
            mock.patch.object(analysis, "MAX_FILE_BYTES", 4),
            self.assertRaises(analysis.InvalidRequestError),
        ):
            self.run_analysis()

        with (
            mock.patch.object(analysis, "MAX_TOTAL_BYTES", 1),
            self.assertRaises(analysis.InvalidRequestError),
        ):
            self.run_analysis()

    def test_invalid_source_encoding_and_mutation_ranges_fail_closed(self):
        (self.root / "src" / "changed.ts").write_bytes(b"\xff")
        with self.assertRaises(analysis.InvalidRequestError):
            self.run_analysis()
        (self.root / "src" / "changed.ts").write_text(self.source, encoding="utf-8")
        with (
            mock.patch.object(
                self.tools,
                "sites_in_file",
                return_value=[
                    Site(
                        "src/changed.ts",
                        "module",
                        "defn/check",
                        "check",
                        1,
                        0,
                        1,
                        ">",
                        ">=",
                        "comparison",
                        "bad-range",
                    )
                ],
            ),
            self.assertRaises(analysis.InvalidRequestError),
        ):
            self.run_analysis()
        with (
            mock.patch.object(analysis, "MAX_SOURCE_FILES", 1),
            self.assertRaises(analysis.InvalidRequestError),
        ):
            self.run_analysis()

    def test_dependency_folders_are_not_scanned(self):
        dependency = self.root / "node_modules" / "package"
        dependency.mkdir(parents=True)
        (dependency / "unrelated.ts").write_text(self.source, encoding="utf-8")
        self.run_analysis()
        self.assertTrue(
            all("node_modules" not in path.parts for path in self.tools.dryer_inputs)
        )

    def test_cli_rejects_malformed_or_oversized_input_with_one_safe_json_report(self):
        for payload in [b"not-json", b"\xff", b"x" * (analysis.MAX_INPUT_BYTES + 1)]:
            stdout = io.StringIO()
            with (
                mock.patch("sys.stdin", SimpleNamespace(buffer=io.BytesIO(payload))),
                mock.patch("sys.stdout", stdout),
            ):
                code = analysis.main()
            self.assertEqual(code, 1)
            report = json.loads(stdout.getvalue())
            self.assertEqual(report["error"]["code"], "invalid-request")

    def test_offline_parser_adapter_validates_bundled_grammars_without_network(self):
        package = SimpleNamespace(get_language=mock.Mock(return_value=object()))
        with (
            mock.patch.object(
                analysis,
                "version",
                side_effect=lambda name: (
                    "0.7.3" if name == "tree-sitter-language-pack" else "0.24.0"
                ),
            ),
            mock.patch.object(analysis, "import_module", return_value=package),
        ):
            analysis.configure_bundled_parsers()
        package.download(["typescript", "javascript"])
        self.assertEqual(
            package.get_language.call_args_list,
            [mock.call("typescript"), mock.call("javascript")],
        )

    def test_dynamic_download_language_pack_is_rejected_before_import(self):
        importer = mock.Mock()
        with (
            mock.patch.object(analysis, "version", return_value="1.22.1"),
            mock.patch.object(analysis, "import_module", importer),
            self.assertRaises(ImportError),
        ):
            analysis.configure_bundled_parsers()
        importer.assert_not_called()


if __name__ == "__main__":
    unittest.main()

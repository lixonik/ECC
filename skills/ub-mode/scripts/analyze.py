import hashlib
import io
import json
import os
import stat
import sys
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import asdict
from importlib import import_module
from importlib.metadata import version
from pathlib import Path, PureWindowsPath
from types import SimpleNamespace

MAX_INPUT_BYTES = 1024 * 1024
MAX_OUTPUT_BYTES = 4 * 1024 * 1024
MAX_SOURCE_FILES = 2000
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BYTES = 32 * 1024 * 1024
MAX_MUTATION_SITES = 5000
SKIP_DIRECTORIES = {
    ".git",
    ".hg",
    ".svn",
    ".idea",
    ".venv",
    "venv",
    "node_modules",
    "vendor",
    "target",
    "dist",
    "build",
    "out",
    "coverage",
    ".metrics",
    "testdata",
    "__pycache__",
    ".clj-kondo",
    ".angular",
    ".cache",
    "test",
    "tests",
    "spec",
    "specs",
    "__tests__",
}
MANIFEST = json.loads(
    (Path(__file__).parent.parent / "tools.json").read_text(encoding="utf-8")
)
SOURCE_EXTENSIONS = {
    extension for tool in MANIFEST["tools"].values() for extension in tool["extensions"]
}


class InvalidRequestError(ValueError):
    pass


def path_key(value):
    normalized = Path(value).as_posix()
    return normalized.casefold() if os.name == "nt" else normalized


def linked_path(path):
    attributes = path.lstat()
    return stat.S_ISLNK(attributes.st_mode) or bool(
        getattr(attributes, "st_file_attributes", 0)
        & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    )


def source_file(path):
    name = path.name
    if path.suffix not in SOURCE_EXTENSIONS or name.endswith(".d.ts"):
        return False
    if (
        name == "conftest.py"
        or (name.startswith("test_") and path.suffix == ".py")
        or name.endswith(
            (
                "_test.py",
                "_test.go",
                "_test.clj",
                "_test.cljc",
                "_test.cljs",
                "_test.bb",
            )
        )
    ):
        return False
    return not any(marker in name for marker in (".test.", ".spec."))


def request_files(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get("project"), str):
        raise InvalidRequestError(
            "Provide an absolute project directory and a list of relative files"
        )
    if not payload["project"] or any(ord(char) < 32 for char in payload["project"]):
        raise InvalidRequestError(
            "The project path must not contain control characters"
        )
    requested = Path(payload["project"])
    if not requested.is_absolute() or not requested.is_dir():
        raise InvalidRequestError("The project must be an existing absolute directory")
    project = requested.resolve()
    files = payload.get("files")
    if not isinstance(files, list) or len(files) > MAX_SOURCE_FILES:
        raise InvalidRequestError("Provide a bounded list of relative files")
    selected = set()
    for value in files:
        if (
            not isinstance(value, str)
            or not value
            or any(ord(char) < 32 for char in value)
        ):
            raise InvalidRequestError("File paths must be nonempty relative strings")
        relative = Path(value.replace("\\", "/"))
        if (
            relative.is_absolute()
            or PureWindowsPath(value).drive
            or ".." in relative.parts
        ):
            raise InvalidRequestError("File paths must stay inside the project")
        current = project
        for part in relative.parts:
            current /= part
            if not current.exists() or linked_path(current):
                raise InvalidRequestError(
                    "Selected paths must exist without symbolic links"
                )
        if not current.is_file():
            raise InvalidRequestError("Selected paths must be regular files")
        selected.add(path_key(current.relative_to(project)))
    return project, selected


def source_record(path, project):
    if linked_path(path) or not path.is_file():
        raise InvalidRequestError(
            "Source paths must be regular files without symbolic links"
        )
    size = path.stat().st_size
    if size > MAX_FILE_BYTES:
        raise InvalidRequestError("A source file exceeds the analysis byte limit")
    with path.open("rb") as stream:
        data = stream.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        raise InvalidRequestError("A source file exceeds the analysis byte limit")
    try:
        source = data.decode("utf-8")
    except UnicodeError as error:
        raise InvalidRequestError("Source files must contain valid UTF-8") from error
    return {
        "path": path,
        "relative": path.relative_to(project).as_posix(),
        "source": source,
        "bytes": data,
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def collect_sources(project):
    records = {}
    total = 0
    for directory, names, filenames in os.walk(project, followlinks=False):
        names[:] = sorted(name for name in names if name not in SKIP_DIRECTORIES)
        if any(linked_path(Path(directory) / name) for name in names):
            raise InvalidRequestError("Source directories must not be symbolic links")
        for name in sorted(filenames):
            path = Path(directory) / name
            if not source_file(path):
                continue
            if linked_path(path) or not path.is_file():
                raise InvalidRequestError(
                    "Source files must be regular files without symbolic links"
                )
            if len(records) >= MAX_SOURCE_FILES:
                raise InvalidRequestError(
                    "The source tree exceeds the analysis file limit"
                )
            record = source_record(path, project)
            total += len(record["bytes"])
            if total > MAX_TOTAL_BYTES:
                raise InvalidRequestError(
                    "The source tree exceeds the analysis byte limit"
                )
            records[path_key(record["relative"])] = record
    return records


def configure_bundled_parsers():
    for name, expected in MANIFEST["parser"].items():
        if name == "compatibility":
            continue
        if version(name) != expected:
            raise ImportError("Install the pinned bundled parser dependencies")
    package = import_module("tree_sitter_language_pack")

    def ensure_bundled_languages(names):
        for name in names:
            package.get_language(name)
        return 0

    package.download = ensure_bundled_languages


def load_backend(name):
    expected = MANIFEST["tools"][name]["version"]
    if version(name) != expected:
        raise ImportError("Install the pinned quality tool version")
    configure_bundled_parsers()
    discover = import_module(
        "crapper.discover" if name == "mutator" else f"{name}.discover"
    )
    shared = {"version": expected, "language_of": discover.language_of}
    if name == "crapper":
        return SimpleNamespace(
            **shared,
            analyze_files=import_module("crapper.analyze").analyze_files,
            load_bundle=import_module("crapper.coverage").load_bundle,
            functions_in_file=import_module("crapper.languages").functions_in_file,
        )
    if name == "dryer":
        module = import_module("dryer.scan")
        return SimpleNamespace(
            **shared,
            scan_files=module.scan_files,
            find_duplicates=module.find_duplicates,
        )
    return SimpleNamespace(
        **shared,
        sites_in_file=import_module("mutator.functions").sites_in_file,
        covered_lines=import_module("mutator.coverage").covered_lines,
    )


def applicable_records(name, records):
    extensions = MANIFEST["tools"][name]["extensions"]
    return [
        record for record in records.values() if record["path"].suffix in extensions
    ]


def tool_report(status, **fields):
    return {"status": status, "version": None, **fields}


def function_locations(backend, records, project):
    found = {}
    for record in records:
        functions = backend.functions_in_file(
            backend.language_of(record["path"]),
            record["source"],
            record["relative"],
            str(project),
        )
        for function in functions:
            found[(path_key(record["relative"]), function.namespace, function.name)] = (
                function
            )
    return found


def crapper_report(backend, records, selected, project):
    bundle = backend.load_bundle(project)
    entries = backend.analyze_files(
        [record["path"] for record in records], project, bundle
    )
    locations = function_locations(
        backend,
        [record for record in records if path_key(record["relative"]) in selected],
        project,
    )
    scored = []
    missing = set()
    for entry in entries:
        if path_key(entry.path) not in selected:
            continue
        function = locations[(path_key(entry.path), entry.namespace, entry.name)]
        if bundle.percent_for(function) is None:
            missing.add(entry.path)
        scored.append(
            {**asdict(entry), "line": function.start_line, "endLine": function.end_line}
        )
    findings = [
        entry for entry in scored if entry["crap"] is not None and entry["crap"] >= 10
    ]
    status = (
        "fail"
        if findings
        else "incomplete"
        if missing
        else "pass"
        if scored
        else "not-applicable"
    )
    return tool_report(
        status,
        version=backend.version,
        mode="existing-coverage",
        entries=scored,
        findings=findings,
        coverageMissing=sorted(missing),
    )


def dryer_report(backend, records, selected, project):
    entries, warnings = backend.scan_files(
        [record["path"] for record in records], project, min_lines=4, min_nodes=20
    )
    candidates = backend.find_duplicates(entries, 0.8)
    duplicates = [
        asdict(item)
        for item in candidates
        if path_key(item.left.file) in selected or path_key(item.right.file) in selected
    ]
    status = "fail" if duplicates else "incomplete" if warnings else "pass"
    return tool_report(
        status, version=backend.version, duplicates=duplicates, warnings=warnings
    )


def mutator_report(backend, records, selected, project):
    sites = []
    for record in records:
        if path_key(record["relative"]) not in selected:
            continue
        language = backend.language_of(record["path"])
        covered = backend.covered_lines(project, record["path"], language)
        for site in backend.sites_in_file(
            record["source"], record["path"], project, record["relative"]
        ):
            if len(sites) >= MAX_MUTATION_SITES:
                raise InvalidRequestError(
                    "The mutation inventory exceeds the site limit"
                )
            if (
                site.start < 0
                or site.end <= site.start
                or record["bytes"][site.start : site.end].decode("utf-8")
                != site.original
            ):
                raise InvalidRequestError(
                    "Mutation byte ranges do not match the source"
                )
            hit = (
                None
                if covered is None
                else site.line in covered or site.anchor_line in covered
            )
            sites.append(
                {**asdict(site), "sourceSha256": record["sha256"], "covered": hit}
            )
    return tool_report(
        "inventory",
        version=backend.version,
        mode="scan",
        sites=sites,
        covered=sum(site["covered"] is True for site in sites),
        uncovered=sum(site["covered"] is False for site in sites),
        unknownCoverage=sum(site["covered"] is None for site in sites),
        message="Mutation sites were inventoried; no mutants or tests were executed",
    )


ANALYZERS = {
    "crapper": crapper_report,
    "dryer": dryer_report,
    "mutator": mutator_report,
}


def run_tool(name, records, selected, project, loader):
    supported = applicable_records(name, records)
    eligible = {path_key(record["relative"]) for record in supported} & selected
    unsupported = sorted(
        record["relative"]
        for key, record in records.items()
        if key in selected and key not in eligible
    )
    if not eligible:
        return tool_report("not-applicable", unsupportedFiles=unsupported)
    try:
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            backend = loader(name)
            report = ANALYZERS[name](backend, supported, eligible, project)
        status = (
            "incomplete"
            if unsupported and report["status"] in {"pass", "inventory"}
            else report["status"]
        )
        return {**report, "status": status, "unsupportedFiles": unsupported}
    except ImportError:
        return tool_report(
            "unavailable", message="Install the pinned ub-mode tool dependencies"
        )
    except InvalidRequestError:
        raise
    except Exception:
        return tool_report(
            "error", message="The pinned quality tool could not analyze this snapshot"
        )


def ensure_unchanged(records, project):
    for record in records.values():
        if source_record(record["path"], project)["sha256"] != record["sha256"]:
            raise InvalidRequestError(
                "Source files changed during analysis; retry on a stable snapshot"
            )


def analyze(payload, loader=None):
    project, selected = request_files(payload)
    if not any(source_file(Path(name)) for name in selected):
        return {
            "schemaVersion": 1,
            "tools": {name: tool_report("not-applicable") for name in ANALYZERS},
        }
    records = collect_sources(project)
    reports = {
        name: run_tool(name, records, selected, project, loader or load_backend)
        for name in ANALYZERS
    }
    ensure_unchanged(records, project)
    return {"schemaVersion": 1, "tools": reports}


def main():
    code = 0
    try:
        data = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(data) > MAX_INPUT_BYTES:
            raise InvalidRequestError(
                "The analysis request exceeds the input byte limit"
            )
        report = analyze(json.loads(data.decode("utf-8")))
        output = json.dumps(report, ensure_ascii=True, separators=(",", ":"))
        if len(output.encode("utf-8")) > MAX_OUTPUT_BYTES:
            raise InvalidRequestError(
                "The analysis report exceeds the output byte limit"
            )
    except (InvalidRequestError, UnicodeError, json.JSONDecodeError):
        output = json.dumps(
            {
                "schemaVersion": 1,
                "error": {
                    "code": "invalid-request",
                    "message": "Provide a bounded, stable project snapshot and valid relative source paths",
                },
            }
        )
        code = 1
    except Exception:
        output = json.dumps(
            {
                "schemaVersion": 1,
                "error": {
                    "code": "analysis-failed",
                    "message": "The quality analysis could not complete",
                },
            }
        )
        code = 1
    print(output)
    return code


if __name__ == "__main__":
    sys.exit(main())

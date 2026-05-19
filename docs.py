#!/usr/bin/env python

import os
import re
import shutil
from argparse import ArgumentParser
from dataclasses import dataclass
from pathlib import Path
from subprocess import check_call
from typing import Literal


@dataclass
class Args:
    target: Literal["core", "cake", "vintage"]


def parse_args() -> Args:
    p = ArgumentParser()
    _ = p.add_argument("--target", required=True)
    return Args(**p.parse_args().__dict__)


def main(args: Args) -> None:
    is_vs = args.target == "vintage"
    out = "dedo-out"
    shutil.rmtree(out, ignore_errors=True)
    if args.target == "core":
        dll = "VinTest/bin/Release/net8.0/VinTest.dll"
    elif args.target == "cake":
        dll = "VinTest.Cake/bin/Release/net8.0/VinTest.Cake.dll"
    elif args.target == "vintage":
        e = os.getenv("VINTAGE_STORY")
        if not e:
            raise Exception("VINTAGE_STORY env not set")
        dll = Path(e) / "VintagestoryAPI.dll"
        out = f"{out}/VintagestoryAPI"
    else:
        raise RuntimeError(f"unsupported target {args.target}")

    cmd = [
        "dotnet",
        "defaultdocumentation",
        "--AssemblyFilePath",
        str(dll),
        "--OutputDirectoryPath",
        str(out),
        "--GeneratedAccessModifiers",
        "Api",
    ]
    if is_vs:
        cmd.extend([
            "--LinksBaseUrl",
            "https://apidocs.vintagestory.at/api/",
            "--LinksOutputFilePath",
            "vs-api-links.txt",
            # defdoc produces ridiculously long filenames on windows and we do not even need them
            "--FileNameFactory",
            "Md5",
            "--GeneratedPages",
            "Enums",
        ])
    else:
        cmd.extend([
            # consume file produced by `vintage` target
            "--ExternLinksFilePaths",
            "vs-api-links.txt",
            # default `namespaces,types,members` produces separate page for each function, that's
            # unfeasible with zensical
            "--GeneratedPages",
            "Namespaces,Types",
        ])
    _ = check_call(cmd)

    # defdoc dumps all links as .md files, while apidocs hosts them as .html
    if is_vs:
        content = Path("vs-api-links.txt").read_text()
        content = re.sub(
            r"\.md\b",
            r".html",
            content,
        )
        _ = Path("vs-api-links.txt").write_text(content)
        return

    # amend some of defdoc extreme verbosity
    for md_file in Path(out).rglob("*.md"):
        content = md_file.read_text(encoding="utf-8")

        # easier to do this than setup config json with MarkdownSanitizationRegex
        content = content.replace(r"\<", "<")
        content = content.replace(r"\(", "(")
        content = content.replace(r"\)", ")")

        # strip long System.* prefixes
        # - first in links
        content = re.sub(
            r"\[System\\\.(?:[A-Za-z_]\w*\\\.)*([A-Za-z_]\w*)(&lt;)?\]",
            r"[\1\2]",
            content,
        )

        # - then in code blocks
        def replace_in_codeblock(match: re.Match[str]) -> str:
            block = match.group(1)
            block = re.sub(r"System\.(?:[A-Za-z_]\w*\.)*([A-Za-z_]\w*)\b", r"\1", block)
            return f"```csharp\n{block}```"

        content = re.sub(
            r"```csharp\n(.*?)```",
            replace_in_codeblock,
            content,
            flags=re.DOTALL,
        )

        # use zensical frontmatter to disable table-of-contents (it is too messy in defdoc)
        content = "---\nhide:\n - toc\n---\n" + content

        _ = md_file.write_text(content, encoding="utf-8")


if __name__ == "__main__":
    main(parse_args())

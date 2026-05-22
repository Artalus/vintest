---
hide:
  - navigation
  - toc
title: Home
---

<div class="home-columns" markdown>
<div class="left" markdown>

# VinTest

In-game testing framework for [Vintage Story](https://www.vintagestory.at/) mods.

VinTest lets you write automated tests that run inside the actual game, against real game state.
Instead of guessing whether your mod works, you launch VS with a companion test mod loaded alongside,
and the framework verifies your logic, then exits and reports the results.

______________________________________________________________________

VinTest is split into three "layers":

1. **Core** (`VinTest` C# package) — the in-game test runner.
    Write test classes in C#, launch VS, see results in the log files and the `results.json`.

1. **Cake task** (`VinTest.Cake` C# package) — automates the full cycle: build both mods, launch VS, collect
    results, and print a summary.
    Uses [Cake](https://cakebuild.net/), which ships with popular VS mod templates.

1. **VS Code extension** — surfaces test results directly in the VS Code
    [Test Explorer](https://code.visualstudio.com/docs/editor/testing).

______________________________________________________________________

→ [Quickstart](quickstart/getting-started.md) — add VinTest to an existing mod project step by step.

</div>
<div class="right" markdown>

![](/vintest/img/demo.png)

![](/vintest/img/demo-cli.png)

</div>
</div>

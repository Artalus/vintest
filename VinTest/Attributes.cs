using System;

namespace VinTest;

/// <summary>
/// Designates a collection of test methods.
/// </summary>
[AttributeUsage(AttributeTargets.Class)]
public sealed class GameTestSuiteAttribute : Attribute { }

/// <summary>
/// Designates a single test method in the test suite class.
/// </summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class GameTestAttribute : Attribute { }
